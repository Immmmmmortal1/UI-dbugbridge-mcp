import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../Sources/LookDebugBridge/LookDebugBridge.swift", import.meta.url);

test("LookDebugBridge actively asks LookinServer to listen instead of reporting a false ready state", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.match(source, /setValue\(true, forKey: "applicationIsActive"\)/);
  assert.match(source, /NSSelectorFromString\("searchPortToListenIfNoConnection"\)/);
  assert.match(source, /perform\(listenSelector\)/);
  assert.doesNotMatch(source, /print\("Lookin ready"\)/);
});
