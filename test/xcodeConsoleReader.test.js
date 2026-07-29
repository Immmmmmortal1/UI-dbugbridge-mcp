import assert from "node:assert/strict";
import test from "node:test";

import { XcodeConsoleReader } from "../src/xcodeConsoleReader.js";

test("read forwards bounded options and returns only script output", async () => {
  let received;
  const reader = new XcodeConsoleReader({
    runScript: async (options) => {
      received = options;
      return { source: "xcode_debug_console", totalCharacters: 10, lines: ["matched"] };
    },
  });

  const result = await reader.read({ query: "[Log]", tailLines: 99999, maxResults: 99999, maxCharsPerLine: 99999 });
  assert.equal(result.success, true);
  assert.deepEqual(received, {
    query: "[Log]",
    tailLines: 2000,
    maxResults: 500,
    maxCharsPerLine: 10000,
  });
  assert.deepEqual(result.payload.lines, ["matched"]);
});

test("read exposes stable Xcode and Accessibility errors", async () => {
  const reader = new XcodeConsoleReader({
    runScript: async () => {
      const error = new Error("osascript failed");
      error.stderr = "Error: xcode_console_not_found";
      throw error;
    },
  });

  const result = await reader.read();
  assert.equal(result.success, false);
  assert.equal(result.error, "xcode_console_not_found");
});

test("read preserves structured diagnostics when the Console node is unavailable", async () => {
  const reader = new XcodeConsoleReader({
    runScript: async () => ({
      source: "xcode_debug_console",
      status: "unavailable",
      error: "xcode_console_not_found",
      diagnostics: { windowCount: 0, accessibleNodeCount: 1023, candidateCount: 0 },
    }),
  });

  const result = await reader.read();
  assert.equal(result.success, false);
  assert.equal(result.error, "xcode_console_not_found");
  assert.deepEqual(result.payload.diagnostics, {
    windowCount: 0,
    accessibleNodeCount: 1023,
    candidateCount: 0,
  });
});

test("wait delegates one transient Console wait without requesting historical text", async () => {
  let received;
  const reader = new XcodeConsoleReader({
    runScript: async (options) => {
      received = options;
      return { source: "xcode_debug_console", status: "matched", lines: ["new match"] };
    },
  });

  const result = await reader.wait({ query: "match", timeoutMs: 1000, intervalMs: 250 });
  assert.equal(result.success, true);
  assert.equal(result.payload.status, "matched");
  assert.deepEqual(result.payload.lines, ["new match"]);
  assert.equal(received.mode, "wait");
  assert.equal(received.timeoutMs, 1000);
  assert.equal(Object.hasOwn(received, "afterCharacter"), false);
});

test("wait returns an empty timeout result without persisting Console text", async () => {
  const reader = new XcodeConsoleReader({
    runScript: async () => ({
      source: "xcode_debug_console",
      status: "timeout",
      nextCharacter: 20,
      lines: [],
    }),
  });

  const result = await reader.wait({ query: "never", timeoutMs: 0 });
  assert.equal(result.payload.status, "timeout");
  assert.deepEqual(result.payload.lines, []);
  assert.equal(Object.hasOwn(reader, "entries"), false);
});
