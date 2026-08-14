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
      getIdentity: async () => ({
        ok: true,
        status: 200,
        payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 42671 },
      }),
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

test("preflight syncs the bridge client to the allocated local port", async () => {
  const dependencies = makeDependencies();
  dependencies.portForwarder.ensureAll = async () => {
    dependencies.config.bridgeBaseURL = "http://127.0.0.1:41020";
    return { success: true, payload: { forwards: [{ localPort: 41020 }] }, error: null };
  };
  dependencies.bridgeClient.setBaseURL = (baseURL) => {
    dependencies.bridgeClient.baseURL = baseURL;
  };
  dependencies.bridgeClient.ping = async () => {
    assert.equal(dependencies.bridgeClient.baseURL, "http://127.0.0.1:41020");
    return { ok: true, status: 200, payload: { success: true } };
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
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

test("preflight scans the next remote port when the first bridge belongs to another App", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.portForwarder.ensureAll = async () => {
    attempts.push(dependencies.config.portForwards[0].remotePort);
    return { success: true, payload: { forwards: [] }, error: null };
  };
  dependencies.portForwarder.stopAll = () => {};
  dependencies.bridgeClient.getIdentity = async () => ({
    ok: true,
    status: 200,
    payload: attempts.at(-1) === 42671
      ? { ok: true, bundleID: "com.other", sessionID: "other", port: 42671 }
      : { ok: true, bundleID: "com.target", sessionID: "target", port: 42672 },
  });

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target", sessionID: "target" },
    remotePortCandidates: [42671, 42672],
  });

  assert.equal(result.success, true);
  assert.deepEqual(attempts, [42671, 42672]);
  assert.equal(result.payload.remotePort, 42672);
  assert.equal(result.payload.identity.bundleID, "com.target");
});

test("preflight ignores a localhost target when a physical device is present", async () => {
  const dependencies = makeDependencies();
  const calls = [];
  dependencies.portForwarder.stopAll = () => {};
  dependencies.bridgeClient.setBaseURL = (baseURL) => {
    dependencies.bridgeClient.baseURL = baseURL;
  };
  dependencies.bridgeClient.ping = async () => {
    calls.push(dependencies.bridgeClient.baseURL);
    return { ok: true, status: 200, payload: { ok: true } };
  };
  dependencies.bridgeClient.getIdentity = async () => ({
    ok: true,
    status: 200,
    payload: { ok: true, bundleID: "com.device", sessionID: "device", port: 42671 },
  });

  const result = await runEnvironmentPreflight({
    ...dependencies,
    targets: [
      {
        mode: "device",
        deviceUDID: "device-1",
        host: "fd00::1",
        device: { name: "iPhone", deviceUDID: "device-1", transport: "wired", tunnelIPAddress: "fd00::1" },
      },
      {
        mode: "unknown",
        deviceUDID: "",
        host: "127.0.0.1",
        device: null,
      },
    ],
    expectedIdentity: { bundleID: "com.device" },
    remotePortCandidates: [42671],
  });

  assert.equal(result.success, true);
  assert.equal(result.payload.mode, "device");
  assert.equal(result.payload.identity.bundleID, "com.device");
  assert.equal(result.payload.discovered.length, 1);
  assert.equal(dependencies.bridgeClient.baseURL, "http://[fd00::1]:42671");
  assert.deepEqual(calls, ["http://[fd00::1]:42671"]);
});

test("multi-target selection prefers wired device over other live bridges", async () => {
  const { selectLiveBridge } = await import("../src/environmentPreflight.js");
  const selected = selectLiveBridge({
    liveBridges: [
      {
        runtimeTarget: {
          mode: "device",
          deviceUDID: "device-wireless",
          device: { transport: "localNetwork", name: "iPhone" },
        },
        bridgeBaseURL: "http://[fd00::2]:42671",
        identity: { bundleID: "com.wireless" },
      },
      {
        runtimeTarget: {
          mode: "device",
          deviceUDID: "device-1",
          device: { transport: "wired", name: "iPhone" },
        },
        bridgeBaseURL: "http://[fd00::1]:42671",
        identity: { bundleID: "com.device" },
      },
    ],
  });

  assert.equal(selected.runtimeTarget.mode, "device");
  assert.equal(selected.identity.bundleID, "com.device");
});
