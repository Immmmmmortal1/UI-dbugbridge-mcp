import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runEnvironmentPreflight } from "../src/environmentPreflight.js";

function makeDependencies(overrides = {}) {
  return {
    config: { sessionID: "test-session", bridgeBaseURL: "http://127.0.0.1:37777" },
    runtimeTarget: { mode: "device", deviceUDID: "device-1" },
    portForwarder: {
      ensureAll: async () => ({ success: true, payload: { forwards: [] }, error: null }),
      // 扫描切换时调用 stopAllAndWait，提供空实现以匹配新契约
      stopAllAndWait: async () => {},
    },
    bridgeClient: {
      baseURL: "http://127.0.0.1:37777",
      ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
      getIdentity: async () => ({
        ok: true,
        status: 200,
        payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 37777 },
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

test("preflight scans the next explicit remote port when the first bridge belongs to another App", async () => {
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
    payload: attempts.at(-1) === 37777
      ? { ok: true, bundleID: "com.other", sessionID: "other", port: 37777 }
      : { ok: true, bundleID: "com.target", sessionID: "target", port: 37778 },
  });

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target", sessionID: "target" },
    remotePortCandidates: [37777, 37778],
  });

  assert.equal(result.success, true);
  assert.deepEqual(attempts, [37777, 37778]);
  assert.equal(result.payload.remotePort, 37778);
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
    payload: { ok: true, bundleID: "com.device", sessionID: "device", port: 37777 },
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
    remotePortCandidates: [37777],
  });

  assert.equal(result.success, true);
  assert.equal(result.payload.mode, "device");
  assert.equal(result.payload.identity.bundleID, "com.device");
  assert.equal(result.payload.discovered.length, 1);
  assert.equal(dependencies.bridgeClient.baseURL, "http://[fd00::1]:37777");
  assert.deepEqual(calls, ["http://[fd00::1]:37777"]);
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
        bridgeBaseURL: "http://[fd00::2]:37777",
        identity: { bundleID: "com.wireless" },
      },
      {
        runtimeTarget: {
          mode: "device",
          deviceUDID: "device-1",
          device: { transport: "wired", name: "iPhone" },
        },
        bridgeBaseURL: "http://[fd00::1]:37777",
        identity: { bundleID: "com.device" },
      },
    ],
  });

  assert.equal(selected.runtimeTarget.mode, "device");
  assert.equal(selected.identity.bundleID, "com.device");
});

// 默认 ping 不再扫描端口段，App 侧只暴露一个端口（37777）。
// 连续会话复用同一端口：session A release 后 session B 直接 ping 同一端口即可。
test("default ping probes only the default port 37777 when no explicit port is given", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 37777 },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 37777);
  // 默认只探测一个端口，不再扫描 42671-42770
  assert.deepEqual(attempts, [37777]);
});

// activateBridge 成功后必须把 selected.remotePort 同步回 config.portForwards[0].remotePort，
// 避免后续流程残留旧 legacy 端口（probeTargetPorts 循环会把该字段覆盖为最后一个探测端口）
test("activateBridge syncs the selected remotePort back into config.portForwards", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 37777 },
    }),
  };

  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 37777);
  assert.equal(
    dependencies.config.portForwards[0].remotePort,
    37777,
    "activateBridge should sync selected.remotePort back"
  );
});

// 显式 args.remotePort（通过 remotePortCandidates 传入）仍只探测该一个端口，不被默认端口干扰
test("explicit remotePort candidates probe only that single port, ignoring default port", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:37777",
    // 默认端口 37777，但显式指定 42699 时应只探测 42699
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => {},
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:37777",
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
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
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
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: "test-session", port: 37777 },
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

// 显式多端口候选时，selectLiveBridge 选中匹配端口后，activateBridge 必须重新 ensure 该端口，
// 因为 probeTargetPorts 循环结束后 currentForwardRemotePort 停留在最后一个探测端口
test("selected iproxy remotePort is re-ensured after multi-port scan leaves a later port active", async () => {
  const attempts = [];
  const stopCalls = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => {
      attempts.push(dependencies.config.portForwards[0].remotePort);
      return { success: true, payload: { forwards: [] }, error: null };
    },
    stopAllAndWait: async () => { stopCalls.push(true); },
  };
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: dependencies.config.portForwards[0].remotePort === 37777
        ? { ok: true, bundleID: "com.target", sessionID: "test-session", port: 37777 }
        : { ok: true, bundleID: "com.other", sessionID: "other", port: dependencies.config.portForwards[0].remotePort },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target" },
    remotePortCandidates: [37777, 37778, 37779],
  });

  assert.equal(result.success, true);
  assert.equal(result.payload.remotePort, 37777);
  // 扫描 3 个端口后，activateBridge 重新 ensure 选中的 37777
  assert.deepEqual(attempts, [37777, 37778, 37779, 37777]);
  assert.equal(dependencies.config.portForwards[0].remotePort, 37777);
  assert.equal(stopCalls.length >= 3, true);
});

// reactivated iproxy 在重新 ensure 后使用新分配的 bridgeBaseURL，而非 selected 旧 URL
test("reactivated iproxy uses the newly allocated bridgeBaseURL instead of stale selected URL", async () => {
  const attempts = [];
  const dependencies = makeDependencies();
  dependencies.config = {
    sessionID: "test-session",
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
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
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: dependencies.config.portForwards[0].remotePort === 37777
        ? { ok: true, bundleID: "com.target", sessionID: "test-session", port: 37777 }
        : { ok: true, bundleID: "com.other", sessionID: "other", port: 37778 },
    }),
  };

  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { bundleID: "com.target" },
    remotePortCandidates: [37777, 37778],
  });

  assert.equal(result.success, true);
  assert.deepEqual(attempts, [37777, 37778, 37777]);
  assert.equal(dependencies.bridgeClient.baseURL, "http://127.0.0.1:51000");
  assert.equal(result.payload.bridgeBaseURL, "http://127.0.0.1:51000");
});

// sessionID 是上下文标记，不是并发隔离：
// - 默认（未传 args.sessionID）不按 sessionID 过滤，任何活桥都可被选中
// - 用户显式传 args.sessionID 时才按该值做 identity 匹配
// - 多个 MCP 会话并发控制同一 App 仍需后续 ownership/lease 机制
test("preflight does not filter by sessionID by default (no args.sessionID)", async () => {
  const dependencies = makeDependencies();
  // App 返回的 sessionID 是 "some-other-session"（非 "test-session"）
  dependencies.bridgeClient.getIdentity = async () => ({
    ok: true,
    status: 200,
    payload: { ok: true, bundleID: "com.test", sessionID: "some-other-session", port: 37777 },
  });

  // 不传 expectedIdentity，默认行为应放行任意 App sessionID
  const result = await runEnvironmentPreflight(dependencies);

  assert.equal(result.success, true);
  assert.equal(result.payload.identity.sessionID, "some-other-session");
  assert.equal(result.payload.identity.bundleID, "com.test");
});

// 显式 args.sessionID 才会按 sessionID 做严格匹配（用于"认领"特定 App 上下文）
// 注意：即便匹配成功，也不代表真正并发隔离——仍可能两个会话并发控制同一 App
test("preflight filters by sessionID only when args.sessionID is explicitly provided", async () => {
  const dependencies = makeDependencies();
  dependencies.bridgeClient.getIdentity = async () => ({
    ok: true,
    status: 200,
    payload: { ok: true, bundleID: "com.test", sessionID: "expected-session", port: 37777 },
  });

  const ok = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { sessionID: "expected-session" },
  });
  assert.equal(ok.success, true);

  const mismatch = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { sessionID: "different-session" },
  });
  assert.equal(mismatch.success, false);
  assert.match(mismatch.error, /bridge_target_mismatch/);
});

// 复审 P1：显式 args.sessionID 必须优先于 MCP 环境 sessionID（config.sessionID）用于注入。
// 否则 probe / activate 后注入会把 config.sessionID 推给 App，覆盖显式选择，
// 导致 App identity.sessionID 不再匹配 expectedIdentity.sessionID。
// 通过 fake bridgeClient.setSession 记录入参，断言显式 B 不会被 config A 覆盖。
test("explicit expectedIdentity.sessionID wins over config.sessionID for probe + activate injection", async () => {
  const setSessionCalls = [];
  const dependencies = makeDependencies();
  // MCP 环境 sessionID = "config-session-A"
  dependencies.config = {
    sessionID: "config-session-A",
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };
  dependencies.portForwarder = {
    ensureAll: async () => ({ success: true, payload: { forwards: [] }, error: null }),
    stopAllAndWait: async () => {},
  };
  // setSession 覆盖式写入：模拟 App 把最近一次注入值作为 identity.sessionID 返回
  let injectedSessionID = "local";
  dependencies.bridgeClient = {
    baseURL: "http://127.0.0.1:37777",
    setBaseURL: (url) => { dependencies.bridgeClient.baseURL = url; },
    ping: async () => ({ ok: true, status: 200, payload: { success: true } }),
    getIdentity: async () => ({
      ok: true,
      status: 200,
      payload: { ok: true, bundleID: "com.test", sessionID: injectedSessionID, port: 37777 },
    }),
    setSession: async (sessionID) => {
      setSessionCalls.push(sessionID);
      injectedSessionID = sessionID;
      return { ok: true, status: 200, payload: { ok: true, sessionID } };
    },
  };

  // 显式 expectedIdentity.sessionID = "explicit-session-B"，必须优先于 config.sessionID
  const result = await runEnvironmentPreflight({
    ...dependencies,
    expectedIdentity: { sessionID: "explicit-session-B" },
  });

  assert.equal(result.success, true, "should match explicit sessionID, not be overridden by config.sessionID");
  // probe 阶段 + activate 后注入都应使用 explicit-session-B，不能是 config-session-A
  assert.deepEqual(setSessionCalls, ["explicit-session-B", "explicit-session-B"]);
  // identity.sessionID 应为显式值，匹配 expectedIdentity
  assert.equal(result.payload.identity.sessionID, "explicit-session-B");
  // payload.sessionID 仍表示 MCP 当前 config.sessionID（上下文标记），不被显式值改写
  assert.equal(result.payload.sessionID, "config-session-A");
});

// sessionPort() 死代码已删除：sessionID 与端口不再绑定，连续会话复用同一远端 37777
test("config.js no longer exposes sessionPort (sessionID is not port-bound)", async () => {
  const configSource = await readFile(
    new URL("../src/config.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(configSource, /function sessionPort/);
  assert.doesNotMatch(configSource, /sessionPort\(sessionID\)/);
});
