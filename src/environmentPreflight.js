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

function identityMatches(identity, expectedIdentity) {
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

export async function runEnvironmentPreflight({
  config,
  portForwarder,
  bridgeClient,
  runtimeTarget,
  expectedIdentity = null,
  remotePortCandidates,
}) {
  const startedAt = Date.now();
  if (!Array.isArray(config.portForwards) || !config.portForwards[0]) {
    config.portForwards = [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 42671 }];
  }
  const candidates = candidatePorts(config, remotePortCandidates);
  let lastFailure = null;

  for (const [index, remotePort] of candidates.entries()) {
    if (index > 0) {
      portForwarder.stopAll?.();
    }
    config.portForwards[0].remotePort = remotePort;

    const portForward = await captureResult(() => portForwarder.ensureAll());
    const portForwardCheck = normalizeToolResult("port_forward", portForward, "port_forward_failed");
    if (portForwardCheck.success && typeof bridgeClient.setBaseURL === "function") {
      bridgeClient.setBaseURL(config.bridgeBaseURL);
    }

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

    if (!identityMatches(identity, expectedIdentity)) {
      lastFailure = {
        portForwardCheck,
        bridgeCheck,
        identity,
        error: "bridge_target_mismatch",
      };
      portForwarder.stopAll?.();
      continue;
    }

    return {
      success: true,
      payload: {
        mode: "device",
        bridgeBaseURL: bridgeClient.baseURL,
        sessionID: config?.sessionID ?? null,
        runtimeTarget,
        remotePort,
        identity,
        checks: [portForwardCheck, bridgeCheck],
        elapsedMs: Date.now() - startedAt,
      },
      error: null,
    };
  }

  return {
    success: false,
    payload: {
      mode: "device",
      bridgeBaseURL: bridgeClient.baseURL,
      sessionID: config?.sessionID ?? null,
      runtimeTarget,
      remotePortCandidates: candidates,
      lastFailure,
      checks: [
        lastFailure?.portForwardCheck ?? { name: "port_forward", success: false, error: "port_forward_failed" },
        lastFailure?.bridgeCheck ?? { name: "debug_bridge_ping", success: false, error: "debug_bridge_ping_failed" },
      ],
      elapsedMs: Date.now() - startedAt,
    },
    error: lastFailure?.error === "bridge_target_mismatch"
      ? "lookdebug_environment_preflight_failed:bridge_target_mismatch"
      : "lookdebug_environment_preflight_failed:debug_bridge_ping",
  };
}
