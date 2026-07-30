const DEBUG_READY_MARKER = "LookDebugBridge ready";
const CONSOLE_QUERY = "LookDebugBridge";

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

function bridgePingSucceeded(result) {
  return result?.ok === true && result?.payload?.success !== false;
}

function normalizeBridgePing(result) {
  const success = bridgePingSucceeded(result);
  return {
    name: "debug_bridge_ping",
    success,
    payload: result
      ? {
          ok: result.ok === true,
          status: result.status ?? null,
          payload: result.payload ?? null,
        }
      : null,
    error: success ? null : resultError(result, "debug_bridge_ping_failed"),
  };
}

function normalizeToolResult(name, result, fallbackError) {
  const success = result?.success === true;
  return {
    name,
    success,
    payload: result?.payload ?? null,
    error: success ? null : resultError(result, fallbackError),
  };
}

function consoleLines(result) {
  const lines = result?.payload?.lines;
  return Array.isArray(lines) ? lines : [];
}

function buildRuntimeCheck(consoleResult, bridgeCheck) {
  const lines = consoleLines(consoleResult);
  const hasReadyMarker = lines.some((line) => line.includes(DEBUG_READY_MARKER));
  const consoleReadable = consoleResult?.success === true;
  const success = consoleReadable && hasReadyMarker && bridgeCheck.success;

  let error = null;
  if (!consoleReadable) {
    error = `xcode_debug_console_unavailable:${resultError(consoleResult, "xcode_console_read_failed")}`;
  } else if (!hasReadyMarker) {
    error = "debug_registration_or_debug_runtime_missing";
  } else if (!bridgeCheck.success) {
    error = "debug_bridge_not_reachable_after_debug_ready_marker";
  }

  return {
    name: "debug_registration_and_debug_runtime",
    success,
    payload: {
      requiredMarker: DEBUG_READY_MARKER,
      matchedLines: lines.slice(-10),
      console: consoleResult?.payload
        ? {
            source: consoleResult.payload.source ?? null,
            status: consoleResult.payload.status ?? null,
            query: consoleResult.payload.query ?? CONSOLE_QUERY,
            totalCharacters: consoleResult.payload.totalCharacters ?? null,
            diagnostics: consoleResult.payload.diagnostics ?? null,
          }
        : null,
      guidance: success
        ? null
        : "Run the app from Xcode with Run configuration = Debug, and make sure LookDebugBridge.shared.startIfNeeded() is registered before using MCP tools.",
    },
    error,
  };
}

function reconcilePortForwardCheck(portForwardCheck, bridgeCheck, lookinCheck) {
  if (portForwardCheck.success || !bridgeCheck.success || !lookinCheck.success) {
    return portForwardCheck;
  }

  return {
    ...portForwardCheck,
    success: true,
    payload: {
      ...(portForwardCheck.payload ?? {}),
      managedForwarding: false,
      status: "services_reachable_without_managed_port_forward",
      warning: portForwardCheck.error,
    },
    error: null,
  };
}

export async function runEnvironmentPreflight({
  config,
  portForwarder,
  bridgeClient,
  lookinClient,
  xcodeConsoleReader,
  requireLookin = true,
  runtimeTarget = null,
}) {
  const startedAt = Date.now();
  const portForward = await captureResult(() => portForwarder.ensureAll());
  const portForwardCheck = normalizeToolResult("port_forward", portForward, "port_forward_failed");

  const [bridgePing, lookinPing, consoleRead] = await Promise.all([
    captureResult(() => bridgeClient.ping()),
    requireLookin
      ? captureResult(() => lookinClient.ping())
      : Promise.resolve({
          success: true,
          payload: {
            skipped: true,
            reason: "lookin_not_required_for_http_debug_bridge_tool",
          },
          error: null,
        }),
    captureResult(() =>
      xcodeConsoleReader.read({
        query: CONSOLE_QUERY,
        maxResults: 50,
        maxCharsPerLine: 4000,
      })
    ),
  ]);

  const bridgeCheck = normalizeBridgePing(bridgePing);
  const lookinCheck = normalizeToolResult("lookin_ping", lookinPing, "lookin_ping_failed");
  const effectivePortForwardCheck = reconcilePortForwardCheck(portForwardCheck, bridgeCheck, lookinCheck);
  const runtimeCheck = buildRuntimeCheck(consoleRead, bridgeCheck);
  const checks = [effectivePortForwardCheck, bridgeCheck, runtimeCheck, lookinCheck];
  const failed = checks.filter((check) => !check.success);

  return {
    success: failed.length === 0,
    payload: {
      mode: config.lookinMode,
      bridgeBaseURL: config.bridgeBaseURL,
      hasDeviceUDID: Boolean(config.deviceUDID),
      runtimeTarget,
      checks,
      elapsedMs: Date.now() - startedAt,
    },
    error: failed.length === 0
      ? null
      : `lookdebug_environment_preflight_failed:${failed.map((check) => check.name).join(",")}`,
  };
}
