import assert from "node:assert/strict";
import test from "node:test";

import { runEnvironmentPreflight } from "../src/environmentPreflight.js";

function makeDependencies(overrides = {}) {
  return {
    config: { sessionID: "test-session", bridgeBaseURL: "http://127.0.0.1:42671" },
    runtimeTarget: { mode: "device", deviceUDID: "device-1" },
    portForwarder: {
      ensureAll: async () => ({ success: true, payload: { forwards: [] }, error: null }),
      // 扫描切换时调用 stopAllAndWait，提供空实现以匹配新契约
      stopAllAndWait: async () => {},
    },
    bridgeClient: {
      baseURL: "http://127.0.0.1:42671",
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
      baseURL: "http://127.0.0.1:42671",
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
  dependencies.portForwarder.stopAllAndWait = async () => {};
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
  dependencies.portForwarder.stopAllAndWait = async () => {};
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

// 默认 ping 优先复用上一次成功激活的 remotePort（缓存于 portForwards[0].remotePort），
// 避免默认扫描误走旧 legacy 转发路径
test("default ping probes the cached remotePort first when no explicit port is given", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42675 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42676,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => {
      const port = dependencies.config.portForwards[0].remotePort;
      return port === 42675
        ? { ok: true, status: 200, payload: { success: true } }
        : { ok: false, status: 503, payload: { error: "bridge_down" } };
    },
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 42675 },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  // 缓存端口 42675 必须是第一个探测的候选
  assert.equal(attempts[0], 42675, "cached remotePort should be probed first");
  assert.equal(result.payload.remotePort, 42675);
  // 全量扫描（去重后 6 个端口），再恢复选中的 iproxy 端口
  assert.equal(attempts.length, 7);
  // 候选列表里 42675 已去重；末尾第二次是恢复选中的 iproxy 端口
  assert.equal(attempts.filter((p) => p === 42675).length, 2);
});

// activateBridge 成功后必须把 selected.remotePort 同步回 config.portForwards[0].remotePort，
// 避免后续流程残留旧 42770/legacy 端口（probeTargetPorts 循环会把该字段覆盖为最后一个探测端口）
test("activateBridge syncs the selected remotePort back into config.portForwards", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42673,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => {
      const port = dependencies.config.portForwards[0].remotePort;
      return port === 42671
        ? { ok: true, status: 200, payload: { success: true } }
        : { ok: false, status: 503, payload: { error: "bridge_down" } };
    },
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 42671 },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 42671);
  // 最后探测的端口是 42673，但 activateBridge 必须把 selected.remotePort (42671) 同步回 config
  assert.equal(
    dependencies.config.portForwards[0].remotePort,
    42671,
    "activateBridge should sync selected.remotePort back, not leave the last-probed port"
  );
});

// 显式 args.remotePort（通过 remotePortCandidates 传入）仍只探测该一个端口，不被缓存端口干扰
test("explicit remotePort candidates probe only that single port, ignoring cached port", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    // 缓存端口 42675，但显式指定 42699 时应忽略缓存
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42675 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42770,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 42699 },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    remotePortCandidates: [42699],
  });

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 42699);
  // 显式端口只探测一次，不扫描整个范围
  assert.deepEqual(attempts, [42699]);
});

// CoreDevice tunnel 模式下不复用 config.tunnelIPAddress 残留：探测非 tunnel 目标时
// 必须落入 iproxy 模式，不能用上一次 tunnel 激活留下的 stale tunnel IP 短路
test("non-tunnel target falls through to iproxy mode even when config.tunnelIPAddress is stale", async () => {
  const ensureAllCalls = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }],
    bridgeRemotePortExplicit: true,
    // 上一次 tunnel 激活留下的残留 tunnel IP
    tunnelIPAddress: "fd00::1",
  };
  dependencies.runtimeTarget = { mode: "device", deviceUDID: "device-1" };
  dependencies.portForwarder = {
    ensureAll: async () => {
      ensureAllCalls.push(true);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 42671 },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  // 非 tunnel 目标必须调用 portForwarder.ensureAll（落入 iproxy 模式），不能用 stale tunnel IP 短路
  assert.equal(ensureAllCalls.length, 1, "should fall through to iproxy ensureAll, not reuse stale tunnel IP");
  // bridgeClient.baseURL 不应变成 stale tunnel IP 的 URL
  assert.equal(
    dependencies.bridgeClient.baseURL.startsWith("http://[fd00::1]"),
    false,
    "should not reuse stale config.tunnelIPAddress as bridgeBaseURL"
  );
});

test("selected iproxy remotePort is re-ensured after full scan leaves a later port active", async () => {
  const attempts = [];
  const stopCalls = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42673,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => { stopCalls.push(true); },
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: dependencies.config.portForwards[0].remotePort === 42671
        ? { ok: true, bundleID: "com.target", sessionID: "test-session", port: 42671 }
        : { ok: true, bundleID: "com.other", sessionID: "other", port: dependencies.config.portForwards[0].remotePort },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target" },
  });

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 42671);
  assert.deepEqual(attempts, [42671, 42672, 42673, 42671]);
  assert.equal(dependencies.config.portForwards[0].remotePort, 42671);
  assert.equal(stopCalls.length >= 3, true);
});

test("cached remotePort still falls back to default full range when range config is absent", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42675 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: dependencies.config.portForwards[0].remotePort },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  assert.equal(attempts[0], 42675);
  assert.equal(attempts.includes(42770), true);
});

test("selected iproxy remotePort is re-ensured when later probes fail after stopping it", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42672,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      const port = dependencies.config.portForwards[0].remotePort;
      attempts.push(port);
      dependencies.config.bridgeBaseURL = `http://127.0.0.1:${port}`;
      return { success: true, payload: { forwards: [{ remotePort: port }] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => dependencies.config.portForwards[0].remotePort === 42671
      ? { ok: true, status: 200, payload: { success: true } }
      : { ok: false, status: 503, payload: { error: "bridge_down" } },
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.target", sessionID: "test-session", port: 42671 },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target" },
  });

  assert.equal(result.success, true);
  assert.deepEqual(attempts, [42671, 42672, 42671]);
  assert.equal(dependencies.config.portForwards[0].remotePort, 42671);
});

test("reactivated iproxy uses the newly allocated bridgeBaseURL instead of stale selected URL", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:42671",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }],
    bridgeRemotePortStart: 42671,
    bridgeRemotePortEnd: 42672,
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      const port = dependencies.config.portForwards[0].remotePort;
      attempts.push(port);
      dependencies.config.bridgeBaseURL = attempts.length === 3
        ? "http://127.0.0.1:51000"
        : `http://127.0.0.1:${port}`;
      return { success: true, payload: { forwards: [{ remotePort: port }] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:42671",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: dependencies.config.portForwards[0].remotePort === 42671
        ? { ok: true, bundleID: "com.target", sessionID: "test-session", port: 42671 }
        : { ok: true, bundleID: "com.other", sessionID: "other", port: 42672 },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target" },
  });

  assert.equal(result.success, true);
  assert.deepEqual(attempts, [42671, 42672, 42671]);
  assert.equal(dependencies.bridgeClient.baseURL, "http://127.0.0.1:51000");
  assert.equal(result.payload.bridgeBaseURL, "http://127.0.0.1:51000");
});
