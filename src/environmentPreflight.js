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

export async function runEnvironmentPreflight({
  config,
  portForwarder,
  bridgeClient,
  runtimeTarget,
}) {
  const startedAt = Date.now();
  const portForward = await captureResult(() => portForwarder.ensureAll());
  const portForwardCheck = normalizeToolResult("port_forward", portForward, "port_forward_failed");
  const bridgePing = await captureResult(() => bridgeClient.ping());
  const bridgeCheck = normalizeToolResult("debug_bridge_ping", bridgePing, "debug_bridge_ping_failed");
  const checks = [portForwardCheck, bridgeCheck];
  const failed = checks.filter((check) => !check.success);

  return {
    success: failed.length === 0,
    payload: {
      mode: "device",
      bridgeBaseURL: bridgeClient.baseURL,
      sessionID: config?.sessionID ?? null,
      runtimeTarget,
      checks,
      elapsedMs: Date.now() - startedAt,
    },
    error: failed.length === 0
      ? null
      : `lookdebug_environment_preflight_failed:${failed.map((check) => check.name).join(",")}`,
  };
}
