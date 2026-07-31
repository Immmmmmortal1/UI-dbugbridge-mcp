import assert from "node:assert/strict";
import test from "node:test";

import { runEnvironmentPreflight } from "../src/environmentPreflight.js";

function makeDependencies(overrides = {}) {
  return {
    config: { sessionID: "test-session", bridgeBaseURL: "http://127.0.0.1:37777" },
    runtimeTarget: { mode: "device", deviceUDID: "device-1" },
    portForwarder: {
      ensureAll: async () => ({ success: true, payload: { forwards: [] }, error: null }),
    },
    bridgeClient: {
      baseURL: "http://127.0.0.1:37777",
      ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    },
    ...overrides,
  };
}

function checkByName(result, name) {
  return result.payload.checks.find((check) => check.name === name);
}

test("preflight passes with physical-device forwarding and DebugBridge ping", async () => {
  const result = await runEnvironmentPreflight(makeDependencies());

  assert.equal(result.success, true);
  assert.equal(result.payload.mode, "device");
  assert.equal(result.payload.sessionID, "test-session");
  assert.equal(checkByName(result, "port_forward").success, true);
  assert.equal(checkByName(result, "debug_bridge_ping").success, true);
});

test("preflight fails when the in-app DebugBridge is unreachable", async () => {
  const result = await runEnvironmentPreflight(makeDependencies({
    bridgeClient: {
      baseURL: "http://127.0.0.1:37777",
      ping: async () => ({ ok: false, status: 503, payload: { error: "bridge_down" } }),
    },
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /debug_bridge_ping/);
  assert.equal(checkByName(result, "debug_bridge_ping").error, "bridge_down");
});

test("preflight reports forwarding failure instead of hiding it", async () => {
  const result = await runEnvironmentPreflight(makeDependencies({
    portForwarder: {
      ensureAll: async () => ({ success: false, error: "iproxy_not_reachable" }),
    },
  }));

  assert.equal(result.success, false);
  assert.equal(checkByName(result, "port_forward").error, "iproxy_not_reachable");
});
