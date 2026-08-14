import path from "node:path";

export const BRIDGE_REMOTE_PORT_START = 42671;
export const BRIDGE_REMOTE_PORT_END = 42770;

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeCommand(command) {
  return command && command.trim().length > 0 ? command.trim() : null;
}

function isLoopbackURL(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function readURLPort(value, fallback) {
  try {
    const port = Number.parseInt(new URL(value).port, 10);
    return Number.isFinite(port) ? port : fallback;
  } catch {
    return fallback;
  }
}

function withPort(baseURL, port) {
  try {
    const url = new URL(baseURL);
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseURL;
  }
}

function sessionPort(sessionID) {
  let hash = 2166136261;
  for (const byte of Buffer.from(sessionID, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return 42000 + (hash % 2000);
}

export function loadConfig(env = process.env) {
  const bridgeBaseURLValue = (env.BRIDGE_BASE_URL || "http://127.0.0.1:37777").trim();
  const screenshotCommand = sanitizeCommand(env.LOOKDEBUG_SCREENSHOT_COMMAND || "");
  const deviceUDID = (env.LOOKDEBUG_DEVICE_UDID || "").trim();
  const iproxyPath = (env.IPROXY_PATH || "iproxy").trim();
  const bridgeLocalPortExplicit = Boolean(env.BRIDGE_LOCAL_PORT?.trim());
  const bridgeBaseURLExplicit = Boolean(env.BRIDGE_BASE_URL?.trim());
  const bridgeBaseURLPortAuto = !bridgeLocalPortExplicit && !bridgeBaseURLExplicit;
  const bridgeLocalPort = readInteger(
    env.BRIDGE_LOCAL_PORT,
    bridgeBaseURLExplicit ? readURLPort(bridgeBaseURLValue, 37777) : bridgeBaseURLPortAuto ? 0 : 37777
  );
  const bridgeBaseURL = bridgeLocalPortExplicit && isLoopbackURL(bridgeBaseURLValue)
    ? withPort(bridgeBaseURLValue, bridgeLocalPort)
    : bridgeBaseURLValue;
  const sessionID = (
    env.DEV_FLOW_SESSION_ID
    || env.CODEX_THREAD_ID
    || env.CURSOR_CONVERSATION_ID
    || "local"
  ).trim() || "local";
  const bridgeRemotePortExplicit = Boolean(env.BRIDGE_REMOTE_PORT?.trim());
  const bridgeRemotePort = bridgeRemotePortExplicit
    ? readInteger(env.BRIDGE_REMOTE_PORT, BRIDGE_REMOTE_PORT_START)
    : BRIDGE_REMOTE_PORT_START;

  return {
    bridgeBaseURL,
    bridgeBaseURLPortAuto,
    screenshotCommand,
    deviceUDID,
    iproxyPath,
    sessionID,
    portForwards: [
      {
        name: "debug_bridge",
        localPort: bridgeLocalPort,
        autoAllocate: bridgeBaseURLPortAuto,
        remotePort: bridgeRemotePort,
      },
    ],
    bridgeRemotePortExplicit,
    bridgeRemotePortStart: BRIDGE_REMOTE_PORT_START,
    bridgeRemotePortEnd: BRIDGE_REMOTE_PORT_END,
    cwd: process.cwd(),
    screenshotOutputDir: path.join(process.cwd(), ".tmp", "lookdebug-mcp"),
  };
}
