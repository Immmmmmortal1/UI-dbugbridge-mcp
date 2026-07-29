import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_ACTIVATE_DELAY_MS = 500;
const MAX_ACTIVATE_DELAY_MS = 5000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const JXA_SCRIPT = String.raw`
ObjC.import('Foundation');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function sleepMs(ms) {
  if (ms > 0) {
    $.NSThread.sleepForTimeInterval(ms / 1000);
  }
}

function run(argv) {
  const options = JSON.parse(argv[0] || '{}');
  const activateDelayMs = boundedInteger(options.activateDelayMs, 500, 0, 5000);
  const systemEvents = Application('System Events');
  if (!systemEvents.uiElementsEnabled()) {
    throw new Error('accessibility_permission_required');
  }

  const xcodeProcess = systemEvents.processes.byName('Xcode');
  if (!xcodeProcess.exists()) {
    throw new Error('xcode_not_running');
  }

  Application('Xcode').activate();
  try { xcodeProcess.frontmost = true; } catch (_) {}
  sleepMs(activateDelayMs);

  let windowCount = 0;
  try { windowCount = xcodeProcess.windows().length; } catch (_) {}
  if (windowCount === 0) {
    throw new Error('xcode_window_not_found');
  }

  systemEvents.keystroke('r', { using: 'command down' });

  return JSON.stringify({
    source: 'xcode_active_scheme_runner',
    status: 'command_r_sent',
    frontmost: xcodeProcess.frontmost(),
    windowCount,
  });
}
`;

async function runJXA(options) {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", JXA_SCRIPT, JSON.stringify(options)],
    { maxBuffer: 512 * 1024, timeout: MAX_ACTIVATE_DELAY_MS + 10000 }
  );
  return JSON.parse(stdout.trim());
}

export class XcodeRunner {
  constructor({ runScript = runJXA } = {}) {
    this.runScript = runScript;
  }

  async runActiveScheme(options = {}) {
    try {
      const payload = await this.runScript({
        activateDelayMs: boundedInteger(
          options.activateDelayMs,
          DEFAULT_ACTIVATE_DELAY_MS,
          0,
          MAX_ACTIVATE_DELAY_MS
        ),
      });
      return { success: true, payload, error: null };
    } catch (error) {
      return { success: false, payload: null, error: this.#errorMessage(error) };
    }
  }

  #errorMessage(error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const message = stderr || error?.message || "xcode_run_shortcut_failed";
    for (const code of [
      "accessibility_permission_required",
      "xcode_not_running",
      "xcode_window_not_found",
    ]) {
      if (message.includes(code)) return code;
    }
    return `xcode_run_shortcut_failed:${message.slice(0, 500)}`;
  }
}
