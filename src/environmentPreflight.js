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
  preferredMode = "auto",
} = {}) {
  let candidates = liveBridges.filter((entry) => identityMatches(entry.identity, expectedIdentity));

  candidates = candidates.filter((entry) => entry.runtimeTarget?.mode === "device");

  const preferredUDID = String(preferredDeviceUDID || "").trim();
  if (preferredUDID) {
    const exact = candidates.filter((entry) => entry.runtimeTarget?.deviceUDID === preferredUDID);
    if (exact.length > 0) {
      candidates = exact;
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
      portForwarder.stopAll?.();
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
      portForwarder.stopAll?.();
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
    preferredMode,
  });

  if (!selected) {
    const mismatch = Boolean(expectedIdentity?.bundleID || expectedIdentity?.sessionID)
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
            error: mismatch ? "bridge_target_mismatch" : "debug_bridge_ping_failed",
          },
        ],
        elapsedMs: Date.now() - startedAt,
      },
      error: mismatch
        ? "lookdebug_environment_preflight_failed:bridge_target_mismatch"
        : "lookdebug_environment_preflight_failed:debug_bridge_ping",
    };
  }

  activateBridge({ config, bridgeClient, selected });

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
      elapsedMs: Date.now() - startedAt,
    },
    error: null,
  };
}
