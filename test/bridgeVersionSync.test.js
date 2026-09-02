import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBridgeVersionSync,
  parseLatestStableTag,
  parseREADMEBridgeTags,
} from "../scripts/check-bridge-version-sync.js";

test("bridge version check passes local MCP, Pod, and README synchronization", () => {
  const result = checkBridgeVersionSync({ offline: true });
  assert.equal(result.ok, true);
  assert.equal(result.mcpVersion, "0.1.16");
  assert.equal(result.podVersion, "0.1.16");
  assert.deepEqual(result.readmeTags, ["0.1.16"]);
});

test("latest bridge tag parser ignores annotated peeled refs and sorts semver", () => {
  const output = [
    "sha refs/tags/0.1.9",
    "sha refs/tags/0.1.14",
    "sha refs/tags/0.1.14^{}",
    "sha refs/tags/0.1.11",
  ].join("\n");
  assert.equal(parseLatestStableTag(output), "0.1.14");
});

test("README parser reads the documented bridge tag", () => {
  assert.deepEqual(
    parseREADMEBridgeTags("pod 'LookDebugBridge', :git => 'https://github.com/Immmmmmortal1/LookDebugBridgeService.git', :tag => '0.1.14'"),
    ["0.1.14"]
  );
});
