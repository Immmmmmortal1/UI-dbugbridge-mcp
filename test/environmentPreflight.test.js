import assert from "node:assert/strict";
import test from "node:test";

import { runEnvironmentPreflight } from "../src/environmentPreflight.js";

function makeDependencies(overrides = {}) {
  return {
    config: {
      lookinMode: "device",
      bridgeBaseURL: "http://127.0.0.1:37777",
      deviceUDID: "test-device",
    },
    portForwarder: {
      ensureAll: async () => ({ success: true, payload: { forwards: [] }, error: null }),
    },
    bridgeClient: {
      ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    },
    lookinClient: {
      ping: async () => ({ success: true, payload: "lookin ok", error: null }),
    },
    xcodeConsoleReader: {
      read: async () => ({
        success: true,
        payload: {
          source: "xcode_debug_console",
          query: "LookDebugBridge",
          totalCharacters: 100,
          lines: [
            "LookDebugBridge listening on 37777",
            "LookDebugBridge ready",
          ],
        },
        error: null,
      }),
    },
    ...overrides,
  };
}

function checkByName(result, name) {
  return result.payload.checks.find((check) => check.name === name);
}

test("preflight passes when DebugBridge registration marker, bridge ping, Lookin, and ports are ready", async () => {
  const result = await runEnvironmentPreflight(makeDependencies());

  assert.equal(result.success, true);
  assert.equal(result.error, null);
  assert.equal(checkByName(result, "debug_registration_and_debug_runtime").success, true);
  assert.equal(checkByName(result, "debug_bridge_ping").success, true);
  assert.equal(checkByName(result, "lookin_ping").success, true);
  assert.equal(checkByName(result, "port_forward").success, true);
});

test("preflight fails before tool execution when the Debug registration marker is missing", async () => {
  const result = await runEnvironmentPreflight(makeDependencies({
    xcodeConsoleReader: {
      read: async () => ({
        success: true,
        payload: {
          source: "xcode_debug_console",
          query: "LookDebugBridge",
          lines: ["LookDebugBridge listening on 37777"],
        },
        error: null,
      }),
    },
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /debug_registration_and_debug_runtime/);
  assert.equal(checkByName(result, "debug_registration_and_debug_runtime").success, false);
  assert.equal(
    checkByName(result, "debug_registration_and_debug_runtime").error,
    "debug_registration_or_debug_runtime_missing"
  );
});

test("preflight fails when DebugBridge ping is not reachable even if Console has the Debug marker", async () => {
  const result = await runEnvironmentPreflight(makeDependencies({
    bridgeClient: {
      ping: async () => ({ ok: false, status: 503, payload: { error: "bridge_down" } }),
    },
  }));

  assert.equal(result.success, false);
  assert.match(result.error, /debug_bridge_ping/);
  assert.equal(checkByName(result, "debug_bridge_ping").success, false);
  assert.equal(checkByName(result, "debug_bridge_ping").error, "bridge_down");
  assert.equal(checkByName(result, "debug_registration_and_debug_runtime").success, false);
  assert.equal(
    checkByName(result, "debug_registration_and_debug_runtime").error,
    "debug_bridge_not_reachable_after_debug_ready_marker"
  );
});

test("preflight does not block on missing managed port forwarding when services are already reachable", async () => {
  const result = await runEnvironmentPreflight(makeDependencies({
    portForwarder: {
      ensureAll: async () => ({ success: false, payload: null, error: "missing_LOOKDEBUG_DEVICE_UDID" }),
    },
  }));

  assert.equal(result.success, true);
  assert.equal(checkByName(result, "port_forward").success, true);
  assert.equal(checkByName(result, "port_forward").payload.managedForwarding, false);
  assert.equal(checkByName(result, "port_forward").payload.warning, "missing_LOOKDEBUG_DEVICE_UDID");
});
