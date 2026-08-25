import path from "node:path";

// App 侧 LookDebugBridge 默认监听端口，与 Pod 默认值 37777 对齐
// 同一台真机/同一个 App 只暴露一个端口，连续会话直接复用，无需扫描端口段
export const BRIDGE_REMOTE_PORT_DEFAULT = 37777;
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

export function loadConfig(env = process.env) {
  // BRIDGE_BASE_URL / BRIDGE_LOCAL_PORT 默认建议省略（.env.example 也已注释掉）：
  // - 默认行为（未设置）：iproxy 模式下 localPort 动态分配，portForwarder.ensureOnce 在分配后
  //   通过 withPort(this.config.bridgeBaseURL, localPort) 覆盖 placeholder 为实际本机端口；
  //   CoreDevice 隧道模式下 ensureBridgeReachable 用 tunnelIP 覆盖。
  // - 显式设置（仅 iproxy 模式生效）：固定本地端口，CoreDevice 隧道模式忽略
  // 这里保留 "http://127.0.0.1:37777" 仅作为内部 loopback placeholder（bridgeBaseURLPortAuto 时会被覆盖），
  // 不是用户面向的默认值——详见 .env.example 与 README「端口与会话语义」
  const bridgeBaseURLValue = (env.BRIDGE_BASE_URL || "http://127.0.0.1:37777").trim();
  const screenshotCommand = sanitizeCommand(env.LOOKDEBUG_SCREENSHOT_COMMAND || "");
  // Prefer the XcodeBuildMCP/CoreDevice identifier, while keeping the older
  // UDID variable as a compatibility fallback. Runtime target resolution
  // normalizes a CoreDevice identifier to the physical UDID when needed.
  const deviceUDID = (env.LOOKDEBUG_DEVICE_ID || env.LOOKDEBUG_DEVICE_UDID || "").trim();
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
    ? readURLPort(bridgeBaseURLValueSafe, BRIDGE_REMOTE_PORT_DEFAULT)
    : bridgeBaseURLPortAuto ? 0 : BRIDGE_REMOTE_PORT_DEFAULT;
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
  // 远程端口校验：1-65535，否则回退到默认 37777（除非启用危险开关放行任意值）
  const bridgeRemotePort = bridgeRemotePortExplicit
    ? readRemotePort(env.BRIDGE_REMOTE_PORT, BRIDGE_REMOTE_PORT_DEFAULT, allowAnyPort)
    : BRIDGE_REMOTE_PORT_DEFAULT;
  // 显式端口被回退后，等价于未显式指定（让 preflight 走默认端口探测）
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
    allowAnyPort,
    allowAnyURL,
    artifactRoot,
    cwd: process.cwd(),
    screenshotOutputDir: path.join(process.cwd(), ".tmp", "lookdebug-mcp"),
  };
}

// 严格解析整数端口：拒绝尾随垃圾字符（如 "37777junk"），只接受纯数字字符串
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

// 远程端口校验：1-65535，否则回退到默认 37777
function readRemotePort(value, fallback, allowAny) {
  const parsed = parseStrictInt(value);
  if (parsed === null) {
    return fallback;
  }
  if (parsed < 1 || parsed > 65535) {
    return allowAny ? parsed : fallback;
  }
  return parsed;
}
