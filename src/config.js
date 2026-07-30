import path from "node:path";

function readMode(value) {
  if (value === "simulator") return "simulator";
  if (value === "device") return "device";
  return "auto";
}

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeCommand(command) {
  return command && command.trim().length > 0 ? command.trim() : null;
}

export function loadConfig(env = process.env) {
  const bridgeBaseURL = (env.BRIDGE_BASE_URL || "http://127.0.0.1:37777").trim();
  const lookinCliPath = (env.LOOKIN_CLI_PATH || "lookin-cli").trim();
  const lookinMode = readMode((env.LOOKIN_MODE || "auto").trim());
  const lookinHost = (env.LOOKIN_HOST || "127.0.0.1").trim();
  const screenshotCommand = sanitizeCommand(env.LOOKIN_SCREENSHOT_COMMAND || "");
  const deviceUDID = (env.LOOKDEBUG_DEVICE_UDID || "").trim();
  const iproxyPath = (env.IPROXY_PATH || "iproxy").trim();
  const lookinLocalPort = readInteger(env.LOOKIN_LOCAL_PORT, 47175);
  const lookinRemotePort = readInteger(env.LOOKIN_REMOTE_PORT, 47175);
  const bridgeLocalPort = readInteger(env.BRIDGE_LOCAL_PORT, 37777);
  const bridgeRemotePort = readInteger(env.BRIDGE_REMOTE_PORT, 37777);

  return {
    bridgeBaseURL,
    lookinCliPath,
    lookinMode,
    requestedLookinMode: lookinMode,
    lookinHost,
    screenshotCommand,
    deviceUDID,
    iproxyPath,
    portForwards: [
      {
        name: "lookin",
        localPort: lookinLocalPort,
        remotePort: lookinRemotePort,
      },
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
