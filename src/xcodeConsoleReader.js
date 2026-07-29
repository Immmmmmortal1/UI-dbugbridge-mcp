import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TAIL_LINES = 100;
const MAX_TAIL_LINES = 2000;
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const DEFAULT_MAX_CHARS_PER_LINE = 2000;
const MAX_CHARS_PER_LINE = 10000;
const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const MAX_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_WAIT_INTERVAL_MS = 1000;

const JXA_SCRIPT = String.raw`
ObjC.import('Foundation');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function run(argv) {
  const options = JSON.parse(argv[0] || '{}');
  const systemEvents = Application('System Events');
  if (!systemEvents.uiElementsEnabled()) {
    throw new Error('accessibility_permission_required');
  }

  const xcode = systemEvents.processes.byName('Xcode');
  if (!xcode.exists()) {
    throw new Error('xcode_not_running');
  }

  function attribute(node, name, fallback = '') {
    try {
      const value = node[name]();
      return value === undefined || value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function descriptor(node) {
    const role = attribute(node, 'role');
    if (role !== 'AXTextArea' && role !== 'AXText') {
      return { role, description: '', name: '', identifier: '' };
    }
    return {
      role,
      description: attribute(node, 'description'),
      name: attribute(node, 'name'),
      identifier: '',
    };
  }

  function score(candidate) {
    const role = String(candidate.role || '').toLowerCase();
    const searchable = [candidate.description, candidate.name, candidate.identifier]
      .join(' ')
      .toLowerCase();
    const hasConsoleLabel = [
      'console',
      'debug console',
      'debug output',
      '控制台',
      '调试输出',
    ].some((label) => searchable.includes(label));
    let value = role === 'axtextarea' ? 40 : (role === 'axtext' ? 20 : 0);
    if (hasConsoleLabel) value += 100;
    return value;
  }

  function findConsoleArea() {
    let windows = [];
    try { windows = xcode.windows(); } catch (_) {}

    const candidates = [];
    let accessibleNodeCount = null;
    function addCandidate(node, source) {
      const candidate = descriptor(node);
      const candidateScore = score(candidate);
      if (candidateScore < 40) return;
      candidates.push({ node, candidate, score: candidateScore, source });
    }

    if (windows.length > 0) {
      function walk(node, depth) {
        if (depth > 24) return;
        addCandidate(node, 'windows');
        let children = [];
        try { children = node.uiElements(); } catch (_) { return; }
        for (const child of children) walk(child, depth + 1);
      }
      for (const window of windows) walk(window, 0);
    }

    // The process-level collection is cheaper and more stable than walking
    // every node in entireContents, and it still works when windows() is empty.
    let textAreas = [];
    try { textAreas = xcode.textAreas(); } catch (_) {}
    for (const node of textAreas) addCandidate(node, 'textAreas');

    if (windows.length === 0) {
      try { accessibleNodeCount = xcode.entireContents().length; } catch (_) { accessibleNodeCount = 0; }
    }

    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0] || null;
    return {
      area: selected ? selected.node : null,
      diagnostics: {
        windowCount: windows.length,
        accessibleNodeCount,
        candidateCount: candidates.length,
        candidate: selected ? selected.candidate : null,
        source: selected ? selected.source : null,
      },
    };
  }

  let discovery = findConsoleArea();
  let consoleArea = discovery.area;
  const query = typeof options.query === 'string' ? options.query : '';
  const normalizedQuery = query.toLowerCase();
  const tailLines = boundedInteger(options.tailLines, 100, 1, 2000);
  const maxResults = boundedInteger(options.maxResults, 100, 1, 500);
  const maxCharsPerLine = boundedInteger(options.maxCharsPerLine, 2000, 1, 10000);

  if (!consoleArea && options.mode !== 'wait') {
    return JSON.stringify({
      source: 'xcode_debug_console',
      status: 'unavailable',
      error: 'xcode_console_not_found',
      diagnostics: discovery.diagnostics,
    });
  }

  function select(value, requestedStart) {
    const totalCharacters = value.length;
    const truncated = requestedStart !== null && requestedStart > totalCharacters;
    const start = requestedStart === null ? 0 : (truncated ? 0 : requestedStart);
    const selectedText = value.slice(start);
    const allLines = selectedText.split(/\r?\n/);
    let lines;
    if (normalizedQuery) {
      lines = allLines.filter(line => line.toLowerCase().includes(normalizedQuery)).slice(-maxResults);
    } else {
      lines = allLines.slice(-tailLines);
    }
    lines = lines.filter(line => line.length > 0).map(line => line.slice(0, maxCharsPerLine));
    return { totalCharacters, selectedText, truncated, lines };
  }

  if (options.mode === 'wait') {
    const timeoutMs = boundedInteger(options.timeoutMs, 30000, 0, 120000);
    const intervalMs = boundedInteger(options.intervalMs, 1000, 250, 10000);
    const startedAt = Date.now();
    let cursor = consoleArea ? String(consoleArea.value()).length : null;

    while (Date.now() - startedAt < timeoutMs) {
      $.NSThread.sleepForTimeInterval(intervalMs / 1000);
      if (!consoleArea) {
        discovery = findConsoleArea();
        consoleArea = discovery.area;
        if (consoleArea) {
          cursor = String(consoleArea.value()).length;
        }
        continue;
      }
      try {
        const value = String(consoleArea.value());
        const result = select(value, cursor);
        cursor = result.totalCharacters;
        if (result.lines.length > 0 || result.truncated) {
          return JSON.stringify({
            source: 'xcode_debug_console', status: 'matched', totalCharacters: result.totalCharacters,
            selectedCharacters: result.selectedText.length, query: query || null, nextCharacter: cursor,
            truncated: result.truncated, lines: result.lines, diagnostics: discovery.diagnostics,
            elapsedMs: Date.now() - startedAt,
          });
        }
      } catch (_) {
        discovery = findConsoleArea();
        consoleArea = discovery.area;
        if (consoleArea) {
          cursor = String(consoleArea.value()).length;
        }
      }
    }

    if (!consoleArea) {
      return JSON.stringify({
        source: 'xcode_debug_console',
        status: 'unavailable',
        error: 'xcode_console_not_found',
        diagnostics: discovery.diagnostics,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return JSON.stringify({
      source: 'xcode_debug_console', status: 'timeout', query: query || null,
      nextCharacter: cursor, lines: [], diagnostics: discovery.diagnostics,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const value = String(consoleArea.value());
  const requestedStart = Number.isFinite(options.afterCharacter) ? Math.max(0, options.afterCharacter) : null;
  const result = select(value, requestedStart);

  return JSON.stringify({
    source: 'xcode_debug_console',
    totalCharacters: result.totalCharacters,
    selectedCharacters: result.selectedText.length,
    query: query || null,
    afterCharacter: requestedStart,
    nextCharacter: result.totalCharacters,
    truncated: result.truncated,
    lines: result.lines,
    diagnostics: discovery.diagnostics,
  });
}
`;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function runJXA(options) {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", JXA_SCRIPT, JSON.stringify(options)],
    { maxBuffer: 2 * 1024 * 1024, timeout: MAX_WAIT_TIMEOUT_MS + 30000 }
  );
  return JSON.parse(stdout.trim());
}

export class XcodeConsoleReader {
  constructor({ runScript = runJXA } = {}) {
    this.runScript = runScript;
  }

  async read(options = {}) {
    try {
      const payload = await this.runScript(this.#normalizeReadOptions(options));
      if (payload?.error) {
        return { success: false, payload, error: payload.error };
      }
      return { success: true, payload, error: null };
    } catch (error) {
      return { success: false, payload: null, error: this.#errorMessage(error) };
    }
  }

  async wait(options = {}) {
    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 0, MAX_WAIT_TIMEOUT_MS);
    const intervalMs = boundedInteger(options.intervalMs, DEFAULT_WAIT_INTERVAL_MS, 250, 10000);
    try {
      const payload = await this.runScript({
        ...this.#normalizeReadOptions(options),
        mode: "wait",
        timeoutMs,
        intervalMs,
      });
      if (payload?.error) {
        return { success: false, payload, error: payload.error };
      }
      return { success: true, payload, error: null };
    } catch (error) {
      return { success: false, payload: null, error: this.#errorMessage(error) };
    }
  }

  #normalizeReadOptions(options) {
    return {
      query: typeof options.query === "string" ? options.query : "",
      tailLines: boundedInteger(options.tailLines, DEFAULT_TAIL_LINES, 1, MAX_TAIL_LINES),
      maxResults: boundedInteger(options.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS),
      maxCharsPerLine: boundedInteger(
        options.maxCharsPerLine,
        DEFAULT_MAX_CHARS_PER_LINE,
        1,
        MAX_CHARS_PER_LINE
      ),
      ...(Number.isFinite(options.afterCharacter)
        ? { afterCharacter: Math.max(0, options.afterCharacter) }
        : {}),
    };
  }

  #errorMessage(error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const message = stderr || error?.message || "xcode_console_read_failed";
    for (const code of [
      "accessibility_permission_required",
      "xcode_not_running",
      "xcode_window_not_found",
      "xcode_console_not_found",
    ]) {
      if (message.includes(code)) return code;
    }
    return `xcode_console_read_failed:${message.slice(0, 500)}`;
  }
}
