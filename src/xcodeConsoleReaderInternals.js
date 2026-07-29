const CONSOLE_LABELS = [
  "console",
  "debug console",
  "debug output",
  "控制台",
  "调试输出",
];

function normalizedText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function mentionsConsole(candidate) {
  const searchable = [candidate.description, candidate.name, candidate.identifier]
    .map(normalizedText)
    .join(" ");
  return CONSOLE_LABELS.some((label) => searchable.includes(label));
}

function candidateScore(candidate) {
  const role = normalizedText(candidate.role);
  let score = 0;
  if (role === "axtextarea") score += 40;
  if (role === "axtext") score += 20;
  if (mentionsConsole(candidate)) score += 100;
  if (String(candidate.value ?? "").length > 0) score += 5;
  return score;
}

export function chooseConsoleCandidate(candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate) }))
    .filter(({ score }) => score >= 40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0)?.candidate ?? null;
}

export function selectConsoleText(value, requestedStart, options = {}) {
  const text = String(value ?? "");
  const query = typeof options.query === "string" ? options.query : "";
  const normalizedQuery = query.toLowerCase();
  const tailLines = Number.isInteger(options.tailLines) ? options.tailLines : 100;
  const maxResults = Number.isInteger(options.maxResults) ? options.maxResults : 100;
  const maxCharsPerLine = Number.isInteger(options.maxCharsPerLine)
    ? options.maxCharsPerLine
    : 2000;
  const totalCharacters = text.length;
  const hasCursor = Number.isFinite(requestedStart);
  const truncated = hasCursor && requestedStart > totalCharacters;
  const start = hasCursor ? (truncated ? 0 : Math.max(0, requestedStart)) : 0;
  const selectedText = text.slice(start);
  const allLines = selectedText.split(/\r?\n/);
  const lines = normalizedQuery
    ? allLines.filter((line) => line.toLowerCase().includes(normalizedQuery)).slice(-maxResults)
    : allLines.slice(-tailLines);

  return {
    totalCharacters,
    selectedCharacters: selectedText.length,
    afterCharacter: hasCursor ? start : null,
    nextCharacter: totalCharacters,
    truncated,
    lines: lines.filter((line) => line.length > 0).map((line) => line.slice(0, maxCharsPerLine)),
  };
}
