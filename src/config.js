import path from "node:path";

export const BRIDGE_REMOTE_PORT_START = 42671;
export const BRIDGE_REMOTE_PORT_END = 42770;
// 单条 JSON-RPC 消息大小上限（1MB），超限返回 -32602，防止恶意/异常大消息耗尽内存
export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024;

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 读取布尔型环境变量：1/true/yes/on 视为真，其余为假
function readBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function sanitizeCommand(command) {
  return command && command.trim().length > 0 ? command.trim() : null;
}

// 校验 URL 是否为安全的回环地址
// 规则：scheme 必须是 http/https；拒绝带 userinfo 的 URL；host 必须是回环地址
// IPv6 zone（带 % 的 host，如 fe80::1%eth0）视为非回环，除非通过 LOOKDEBUG_ALLOW_ANY_URL 显式放行
function isLoopbackURL(value) {
  try {
    const url = new URL(value);
    // scheme 限制：只允许 http/https，拒绝 file:/data:/javascript: 等
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    // 拒绝带 userinfo 的 URL（如 http://user:pass@host），避免凭证注入
    if (url.username !== "" || url.password !== "") {
      return false;
    }
    // 去掉 IPv6 主机名两侧的方括号后比较
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    // IPv6 zone（带 %）视为非回环，除非显式放行
    if (hostname.includes("%")) {
      return false;
    }
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function readURLPort(value, fallback) {
  try {
    // 用 URL 解析后对 port 字符串做严格校验，拒绝尾随垃圾
    const portStr = new URL(value).port;
    const parsed = parseStrictInt(portStr);
    return parsed !== null ? parsed : fallback;
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
  // BRIDGE_BASE_URL / BRIDGE_LOCAL_PORT 的默认值（127.0.0.1:37777）仅 iproxy 模式使用：
  // - iproxy 模式：本地启动 iproxy 把设备远程端口转回 37777，MCP 访问 127.0.0.1:37777
  // - CoreDevice 隧道模式：ensureBridgeReachable 会用 tunnelIP 覆盖 bridgeBaseURL，
  //   BRIDGE_BASE_URL / BRIDGE_LOCAL_PORT 在此模式下不生效，请勿据此探测本地端口
  const bridgeBaseURLValue = (env.BRIDGE_BASE_URL || "http://127.0.0.1:37777").trim();
  const screenshotCommand = sanitizeCommand(env.LOOKDEBUG_SCREENSHOT_COMMAND || "");
  const deviceUDID = (env.LOOKDEBUG_DEVICE_UDID || "").trim();
  const iproxyPath = (env.IPROXY_PATH || "iproxy").trim();
  // 危险开关：开启后允许 BRIDGE_LOCAL_PORT/BRIDGE_REMOTE_PORT 超出常规范围（默认关闭）
  const allowAnyPort = readBoolean(env.LOOKDEBUG_ALLOW_ANY_PORT);
  // 危险开关：开启后允许 BRIDGE_BASE_URL 指向非回环主机（默认关闭）
  const allowAnyURL = readBoolean(env.LOOKDEBUG_ALLOW_ANY_URL);
  // 可选：artifact 根目录，设置后 audit_runtime 的输入/输出路径必须位于其内
  const artifactRoot = (env.LOOKDEBUG_ARTIFACT_ROOT || "").trim() || null;

  // URL 主机校验：非回环且未启用危险开关 → 回退到默认回环地址
  const bridgeBaseURLValueSafe = isLoopbackURL(bridgeBaseURLValue) || allowAnyURL
    ? bridgeBaseURLValue
    : "http://127.0.0.1:37777";

  const bridgeLocalPortExplicit = Boolean(env.BRIDGE_LOCAL_PORT?.trim());
  const bridgeBaseURLExplicit = Boolean(env.BRIDGE_BASE_URL?.trim()) && bridgeBaseURLValueSafe === bridgeBaseURLValue;
  const bridgeBaseURLPortAuto = !bridgeLocalPortExplicit && !bridgeBaseURLExplicit;
  // 本地端口校验：0 表示自动分配；显式端口需在 1-65535 内，否则回退到默认（除非启用危险开关）
  const bridgeLocalPortFallback = bridgeBaseURLExplicit
    ? readURLPort(bridgeBaseURLValueSafe, 37777)
    : bridgeBaseURLPortAuto ? 0 : 37777;
  const bridgeLocalPort = readLocalPort(
    env.BRIDGE_LOCAL_PORT,
    bridgeLocalPortFallback,
    allowAnyPort
  );
  const bridgeBaseURL = bridgeLocalPortExplicit && isLoopbackURL(bridgeBaseURLValueSafe)
    ? withPort(bridgeBaseURLValueSafe, bridgeLocalPort)
    : bridgeBaseURLValueSafe;
  const sessionID = (
    env.DEV_FLOW_SESSION_ID
    || env.CODEX_THREAD_ID
    || env.CURSOR_CONVERSATION_ID
    || "local"
  ).trim() || "local";
  const bridgeRemotePortExplicit = Boolean(env.BRIDGE_REMOTE_PORT?.trim());
  // 远程端口校验：必须在 42671-42770 范围内，否则回退到默认起始端口（除非启用危险开关）
  const bridgeRemotePort = bridgeRemotePortExplicit
    ? readRemotePort(env.BRIDGE_REMOTE_PORT, BRIDGE_REMOTE_PORT_START, allowAnyPort)
    : BRIDGE_REMOTE_PORT_START;
  // 显式端口被回退后，等价于未显式指定（让 preflight 走全端口扫描）
  const bridgeRemotePortEffectiveExplicit = bridgeRemotePortExplicit
    && bridgeRemotePort === parseStrictInt(env.BRIDGE_REMOTE_PORT);

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
    bridgeRemotePortExplicit: bridgeRemotePortEffectiveExplicit,
    bridgeRemotePortStart: BRIDGE_REMOTE_PORT_START,
    bridgeRemotePortEnd: BRIDGE_REMOTE_PORT_END,
    allowAnyPort,
    allowAnyURL,
    artifactRoot,
    cwd: process.cwd(),
    screenshotOutputDir: path.join(process.cwd(), ".tmp", "lookdebug-mcp"),
  };
}

// 严格解析整数端口：拒绝尾随垃圾字符（如 "42671junk"），只接受纯数字字符串
function parseStrictInt(value) {
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return null;
  }
  // 必须全部是数字字符（允许前导 - 用于负数检查，但端口场景不会有负数）
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// 本地端口校验：0 表示自动分配；显式端口需在 1-65535 内
function readLocalPort(value, fallback, allowAny) {
  const parsed = parseStrictInt(value);
  if (parsed === null) {
    return fallback;
  }
  if (parsed === 0) {
    return 0;
  }
  if (parsed < 1 || parsed > 65535) {
    return allowAny ? parsed : fallback;
  }
  return parsed;
}

// 远程端口校验：必须在 42671-42770 范围内
function readRemotePort(value, fallback, allowAny) {
  const parsed = parseStrictInt(value);
  if (parsed === null) {
    return fallback;
  }
  if (parsed < BRIDGE_REMOTE_PORT_START || parsed > BRIDGE_REMOTE_PORT_END) {
    return allowAny ? parsed : fallback;
  }
  return parsed;
}
