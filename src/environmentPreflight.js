function resultError(result, fallback) {
  return result?.error || result?.payload?.error || fallback;
}

async function captureResult(run) {
  try {
    return await run();
  } catch (error) {
    return {
      success: false,
      payload: null,
      error: error?.message || "preflight_check_failed",
    };
  }
}

function normalizeToolResult(name, result, fallbackError) {
  const success = result?.success === true || result?.ok === true;
  return {
    name,
    success,
    payload: result?.payload ?? null,
    error: success ? null : resultError(result, fallbackError),
  };
}

export function identityMatches(identity, expectedIdentity) {
  if (!expectedIdentity || (!expectedIdentity.bundleID && !expectedIdentity.sessionID)) {
    return true;
  }
  if (!identity) {
    return false;
  }
  if (expectedIdentity.bundleID && identity.bundleID !== expectedIdentity.bundleID) {
    return false;
  }
  if (expectedIdentity.sessionID && identity.sessionID !== expectedIdentity.sessionID) {
    return false;
  }
  return true;
}

function candidatePorts(config, remotePortCandidates) {
  if (Array.isArray(remotePortCandidates) && remotePortCandidates.length > 0) {
    return remotePortCandidates;
  }
  if (config?.bridgeRemotePortExplicit) {
    return [config.portForwards[0].remotePort];
  }
  const configuredPort = config?.portForwards?.[0]?.remotePort;
  const start = config?.bridgeRemotePortStart ?? configuredPort ?? 42671;
  const end = config?.bridgeRemotePortEnd ?? start;
  return Array.from({ length: Math.max(1, end - start + 1) }, (_, index) => start + index);
}

function bridgeURLForHost(host, port) {
  const normalized = String(host || "").trim();
  if (!normalized) {
    return null;
  }
  const needsBrackets = normalized.includes(":") && !normalized.startsWith("[");
  const hostPart = needsBrackets ? `[${normalized}]` : normalized;
  return `http://${hostPart}:${port}`;
}

function summarizeLiveBridge(entry) {
  return {
    mode: entry.runtimeTarget?.mode || null,
    deviceUDID: entry.runtimeTarget?.deviceUDID || "",
    deviceName: entry.runtimeTarget?.device?.name || null,
    transport: entry.runtimeTarget?.device?.transport || null,
    bridgeBaseURL: entry.bridgeBaseURL,
    remotePort: entry.remotePort,
    identity: entry.identity,
  };
}

export function selectLiveBridge({
  liveBridges = [],
  expectedIdentity = null,
  preferredDeviceUDID = "",
  strictDeviceUDID = false,
  preferredMode = "auto",
} = {}) {
  let candidates = liveBridges.filter((entry) => identityMatches(entry.identity, expectedIdentity));

  candidates = candidates.filter((entry) => entry.runtimeTarget?.mode === "device");

  const preferredUDID = String(preferredDeviceUDID || "").trim();
  if (preferredUDID) {
    const exact = candidates.filter((entry) => entry.runtimeTarget?.deviceUDID === preferredUDID);
    if (exact.length > 0) {
      candidates = exact;
    } else if (strictDeviceUDID) {
      // 显式指定 deviceUDID 但无精确匹配，禁止静默回退到其他设备
      return null;
    }
  }

  const wired = candidates.find((entry) => (
    entry.runtimeTarget?.mode === "device"
    && String(entry.runtimeTarget?.device?.transport || "").toLowerCase() === "wired"
  ));
  if (wired) {
    return wired;
  }

  const device = candidates.find((entry) => entry.runtimeTarget?.mode === "device");
  if (device) {
    return device;
  }

  return candidates[0] || null;
}

function isLoopbackHost(host) {
  const normalized = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function ensureBridgeReachable({
  config,
  portForwarder,
  bridgeClient,
  runtimeTarget,
  remotePort,
}) {
  const tunnelIP =
    runtimeTarget?.device?.tunnelIPAddress
    || runtimeTarget?.host
    || config?.tunnelIPAddress
    || null;

  // iOS 17+ / CoreDevice: usbmux iproxy often sees zero devices. Prefer the
  // CoreDevice tunnel IPv6 address and talk to the app port directly.
  // CoreDevice tunnel IPv6 only. Loopback is the local iproxy side, not a device.
  if (tunnelIP && !isLoopbackHost(tunnelIP)) {
    const baseURL = bridgeURLForHost(tunnelIP, remotePort);
    config.bridgeBaseURL = baseURL;
    config.tunnelIPAddress = tunnelIP;
    if (typeof bridgeClient.setBaseURL === "function") {
      bridgeClient.setBaseURL(baseURL);
    }
    return {
      portForwardCheck: {
        name: "port_forward",
        success: true,
        payload: {
          mode: "coredevice_tunnel",
          tunnelIPAddress: tunnelIP,
          remotePort,
          bridgeBaseURL: baseURL,
        },
        error: null,
      },
    };
  }

  if (runtimeTarget?.deviceUDID) {
    config.deviceUDID = runtimeTarget.deviceUDID;
  }

  const portForward = await captureResult(() => portForwarder.ensureAll());
  const portForwardCheck = normalizeToolResult("port_forward", portForward, "port_forward_failed");
  if (portForwardCheck.success && typeof bridgeClient.setBaseURL === "function") {
    bridgeClient.setBaseURL(config.bridgeBaseURL);
  }
  return { portForwardCheck };
}

async function probeTargetPorts({
  config,
  portForwarder,
  bridgeClient,
  runtimeTarget,
  remotePortCandidates,
}) {
  if (!Array.isArray(config.portForwards) || !config.portForwards[0]) {
    config.portForwards = [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }];
  }

  const candidates = candidatePorts(config, remotePortCandidates);
  const live = [];
  let lastFailure = null;

  for (const [index, remotePort] of candidates.entries()) {
    if (index > 0) {
      // 扫描下一个端口前，等待+SIGKILL 清理上一个 iproxy，避免僵尸进程占用端口
      await portForwarder.stopAllAndWait?.();
    }
    config.portForwards[0].remotePort = remotePort;

    const { portForwardCheck } = await ensureBridgeReachable({
      config,
      portForwarder,
      bridgeClient,
      runtimeTarget,
      remotePort,
    });

    const bridgePing = portForwardCheck.success
      ? await captureResult(() => bridgeClient.ping())
      : { success: false, error: "port_forward_failed" };
    const bridgeCheck = normalizeToolResult("debug_bridge_ping", bridgePing, "debug_bridge_ping_failed");
    if (!bridgeCheck.success) {
      lastFailure = { portForwardCheck, bridgeCheck };
      continue;
    }

    // 会话注入必须发生在 getIdentity 之前：
    // App 首次启动（devicectl launch 不注入环境变量）identity.sessionID 恒为 "local"，
    // 若先读 identity 再注入，selectLiveBridge 用真实 sessionID 匹配会因 local 失败而选不到桥（死锁）。
    // 先注入真实会话 id，identity 才能返回正确 sessionID 供匹配。
    // 失败不阻断探测（仍按原 identity 记录），仅记录 warning。
    let sessionInjection = null;
    const probeSessionID = config?.sessionID;
    if (probeSessionID && probeSessionID !== "local" && typeof bridgeClient.setSession === "function") {
      const injection = await captureResult(() => bridgeClient.setSession(probeSessionID));
      sessionInjection = (injection?.ok && injection.payload)
        ? { success: true }
        : { success: false, error: injection?.error || injection?.payload?.error || "session_injection_failed" };
      if (!sessionInjection.success) {
        console.error(`[environmentPreflight] probe session injection failed: ${sessionInjection.error}`);
      }
    }

    let identity = null;
    if (typeof bridgeClient.getIdentity === "function") {
      const identityResult = await captureResult(() => bridgeClient.getIdentity());
      if (identityResult?.ok && identityResult.payload) {
        identity = identityResult.payload;
      }
    }

    live.push({
      runtimeTarget,
      remotePort,
      bridgeBaseURL: bridgeClient.baseURL,
      identity,
      sessionInjection,
      checks: [portForwardCheck, bridgeCheck],
    });
  }

  return { live, lastFailure, remotePortCandidates: candidates };
}

function activateBridge({ config, bridgeClient, selected }) {
  config.bridgeBaseURL = selected.bridgeBaseURL;
  config.runtimeTarget = selected.runtimeTarget;
  config.tunnelIPAddress = selected.runtimeTarget?.device?.tunnelIPAddress
    || selected.runtimeTarget?.host
    || null;
  if (selected.runtimeTarget?.mode === "device" && selected.runtimeTarget.deviceUDID) {
    config.deviceUDID = selected.runtimeTarget.deviceUDID;
  }
  if (typeof bridgeClient.setBaseURL === "function") {
    bridgeClient.setBaseURL(selected.bridgeBaseURL);
  }
}

export async function runEnvironmentPreflight({
  config,
  portForwarder,
  bridgeClient,
  runtimeTarget,
  targets,
  expectedIdentity = null,
  remotePortCandidates,
  preferredDeviceUDID = "",
  strictDeviceUDID = false,
  preferredMode = "auto",
}) {
  const startedAt = Date.now();
  const rawTargets = Array.isArray(targets) && targets.length > 0
    ? targets
    : runtimeTarget
      ? [runtimeTarget]
      : [];
  const targetList = rawTargets.filter((target) => target?.mode === "device");

  if (targetList.length === 0) {
    return {
      success: false,
      payload: {
        mode: "unknown",
        sessionID: config?.sessionID ?? null,
        discovered: [],
        elapsedMs: Date.now() - startedAt,
      },
      error: "lookdebug_environment_preflight_failed:no_runtime_targets",
    };
  }

  const liveBridges = [];
  let lastFailure = null;
  let scannedPorts = [];

  for (const [targetIndex, target] of targetList.entries()) {
    if (targetIndex > 0) {
      // 扫描下一个设备前，等待+SIGKILL 清理上一个设备的 iproxy，避免僵尸进程
      await portForwarder.stopAllAndWait?.();
    }

    const probed = await probeTargetPorts({
      config,
      portForwarder,
      bridgeClient,
      runtimeTarget: target,
      remotePortCandidates,
    });
    scannedPorts = probed.remotePortCandidates;
    liveBridges.push(...probed.live);
    if (probed.lastFailure) {
      lastFailure = probed.lastFailure;
    }
  }

  const selected = selectLiveBridge({
    liveBridges,
    expectedIdentity,
    preferredDeviceUDID: preferredDeviceUDID || config?.deviceUDID || "",
    strictDeviceUDID,
    preferredMode,
  });

  if (!selected) {
    const mismatch = Boolean(expectedIdentity?.bundleID || expectedIdentity?.sessionID)
      && liveBridges.length > 0;
    const deviceMismatch = strictDeviceUDID
      && String(preferredDeviceUDID || "").trim()
      && liveBridges.length > 0;
    return {
      success: false,
      payload: {
        mode: "device",
        bridgeBaseURL: bridgeClient.baseURL,
        sessionID: config?.sessionID ?? null,
        runtimeTarget: runtimeTarget || targetList[0] || null,
        remotePortCandidates: scannedPorts,
        discovered: liveBridges.map(summarizeLiveBridge),
        preferredDeviceUDID: preferredDeviceUDID || config?.deviceUDID || "",
        preferredMode,
        lastFailure,
        checks: [
          lastFailure?.portForwardCheck ?? { name: "port_forward", success: false, error: "port_forward_failed" },
          lastFailure?.bridgeCheck ?? {
            name: "debug_bridge_ping",
            success: false,
            error: mismatch
              ? "bridge_target_mismatch"
              : deviceMismatch
                ? "bridge_device_mismatch"
                : "debug_bridge_ping_failed",
          },
        ],
        elapsedMs: Date.now() - startedAt,
      },
      error: mismatch
        ? "lookdebug_environment_preflight_failed:bridge_target_mismatch"
        : deviceMismatch
          ? "lookdebug_environment_preflight_failed:bridge_device_mismatch"
          : "lookdebug_environment_preflight_failed:debug_bridge_ping",
    };
  }

  activateBridge({ config, bridgeClient, selected });

  // 会话 id 注入：把 Mac 侧真实 sessionID 推给 App，App 的 identity 才能返回正确值
  // - 仅当存在真实会话 id（非 "local"）时才注入；App 默认即 "local"，注入无意义
  // - 失败不阻断 preflight（仅记录 warning），避免桥已通但注入接口异常时整链路失败
  // - 幂等：每次 preflight 都执行，App 重启后重连会再次注入
  const sessionID = config?.sessionID;
  let sessionInjection = null;
  if (sessionID && sessionID !== "local" && typeof bridgeClient.setSession === "function") {
    const injectionResult = await captureResult(() => bridgeClient.setSession(sessionID));
    if (injectionResult?.ok && injectionResult.payload) {
      sessionInjection = { success: true };
    } else {
      sessionInjection = {
        success: false,
        error: injectionResult?.error || "session_injection_failed",
      };
      // 仅记录日志，不改变 preflight 结果
      console.error(
        `[environmentPreflight] session injection failed: ${sessionInjection.error}`
      );
    }
  }

  return {
    success: true,
    payload: {
      mode: selected.runtimeTarget?.mode || "device",
      bridgeBaseURL: selected.bridgeBaseURL,
      sessionID: config?.sessionID ?? null,
      runtimeTarget: selected.runtimeTarget,
      remotePort: selected.remotePort,
      identity: selected.identity,
      discovered: liveBridges.map(summarizeLiveBridge),
      preferredDeviceUDID: preferredDeviceUDID || config?.deviceUDID || "",
      preferredMode,
      checks: selected.checks,
      sessionInjection,
      elapsedMs: Date.now() - startedAt,
    },
    error: null,
  };
}
