import path from "node:path";

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeCommand(command) {
  return command && command.trim().length > 0 ? command.trim() : null;
}

export function loadConfig(env = process.env) {
  const bridgeBaseURL = (env.BRIDGE_BASE_URL || "http://127.0.0.1:37777").trim();
  const screenshotCommand = sanitizeCommand(env.LOOKDEBUG_SCREENSHOT_COMMAND || "");
  const deviceUDID = (env.LOOKDEBUG_DEVICE_UDID || "").trim();
  const iproxyPath = (env.IPROXY_PATH || "iproxy").trim();
  const bridgeLocalPort = readInteger(env.BRIDGE_LOCAL_PORT, 37777);
  const bridgeRemotePort = readInteger(env.BRIDGE_REMOTE_PORT, 37777);
  const sessionID = (env.DEV_FLOW_SESSION_ID || env.CODEX_THREAD_ID || "local").trim() || "local";

  return {
    bridgeBaseURL,
    screenshotCommand,
    deviceUDID,
    iproxyPath,
    sessionID,
    portForwards: [
      {
        name: "debug_bridge",
        localPort: bridgeLocalPort,
        remotePort: bridgeRemotePort,
      },
    ],
    cwd: process.cwd(),
    screenshotOutputDir: path.join(process.cwd(), ".tmp", "lookdebug-mcp"),
  };
}
