import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../Sources/LookDebugBridge/LookDebugBridge.swift", import.meta.url);

test("LookDebugBridge lets the LookinServer lifecycle start exactly one listener", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.doesNotMatch(source, /setValue\(true, forKey: "applicationIsActive"\)/);
  assert.doesNotMatch(source, /NSSelectorFromString\("searchPortToListenIfNoConnection"\)/);
  assert.doesNotMatch(source, /perform\(listenSelector\)/);
  assert.doesNotMatch(source, /print\("Lookin ready"\)/);
  assert.match(source, /print\("LookinServer loaded; listener follows app lifecycle"\)/);
});
