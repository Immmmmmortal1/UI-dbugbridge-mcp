import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../Sources/LookDebugBridge/LookDebugBridge.swift", import.meta.url);

test("LookDebugBridge starts only its in-app bridge and exposes session-scoped logging", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.doesNotMatch(source, /LookinServer/);
  assert.doesNotMatch(source, /startLookinIfAvailable/);
  assert.match(source, /static let sessionID/);
  assert.match(source, /CURSOR_CONVERSATION_ID/);
  assert.match(source, /LookDebugLogStore\.shared\.append/);
});
