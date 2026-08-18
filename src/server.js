import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, MAX_MESSAGE_BYTES } from "./config.js";
import { identityMatches, runEnvironmentPreflight } from "./environmentPreflight.js";
import { HTTPBridgeClient } from "./httpBridgeClient.js";
import { PortForwarder } from "./portForwarder.js";
import { ScreenshotClient } from "./screenshotClient.js";
import { applyRuntimeTarget, RuntimeTargetResolver } from "./runtimeTarget.js";
import {
  assertArtifactPath,
  assertFileSize,
  buildRuntimeAuditReport,
  MAX_FIGMA_RAW_BYTES,
  writeJSONArtifact,
  writeRuntimeAuditArtifacts,
} from "./runtimeAudit.js";

// 从 package.json 读取版本号，避免硬编码导致与 package.json 不一致
const PACKAGE_VERSION = (() => {
  try {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const config = loadConfig();
const bridgeClient = new HTTPBridgeClient({ baseURL: config.bridgeBaseURL });
const portForwarder = new PortForwarder(config);
const screenshotClient = new ScreenshotClient(config);
const runtimeTargetResolver = new RuntimeTargetResolver();

const DEFAULT_PAGE_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_INTERVAL_MS = 300;
const DEFAULT_POST_ACTION_WAIT_MS = 350;
const tools = [
  {
    name: "ping",
    description: "Discover live DebugBridge targets on connected physical devices, then activate one.",
    inputSchema: {
      type: "object",
      properties: {
        bundleID: {
          type: "string",
          description: "Optional target App bundle ID used to select among simultaneous bridges.",
        },
        appID: {
          type: "string",
          description: "Alias for bundleID.",
        },
        sessionID: {
          type: "string",
          description: "Optional target DebugBridge session ID.",
        },
        deviceUDID: {
          type: "string",
          description: "Optional physical device UDID used as a preference when multiple bridges match.",
        },
        mode: {
          type: "string",
          enum: ["auto", "device"],
          description: "Optional runtime mode filter. auto and device both use physical devices only.",
        },
        remotePort: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Optional exact remote bridge port. Without it, ports 42671-42770 are scanned.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "release_session",
    description:
      "Release this MCP session's iproxy forwards and optionally exit the server process. Call after dev-flow commit to avoid orphaned port forwards.",
    inputSchema: {
      type: "object",
      properties: {
        exitAfterRelease: {
          type: "boolean",
          description:
            "When true (default), exit this MCP server after releasing forwards so the host can start a clean instance next session.",
        },
        reason: {
          type: "string",
          description: "Optional audit reason, e.g. dev-flow commit complete.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ensure_ports",
    description: "Scan DebugBridge ports on usable physical devices, keep simultaneous discoveries, and activate the matching target.",
    inputSchema: {
      type: "object",
      properties: {
        bundleID: {
          type: "string",
          description: "Optional target App bundle ID. When provided, selects that App among simultaneous bridges.",
        },
        appID: {
          type: "string",
          description: "Alias for bundleID.",
        },
        sessionID: {
          type: "string",
          description: "Optional target DebugBridge session ID.",
        },
        deviceUDID: {
          type: "string",
          description: "Optional physical device UDID used as a preference when multiple bridges match.",
        },
        mode: {
          type: "string",
          enum: ["auto", "device"],
          description: "Optional runtime mode filter. auto and device both use physical devices only.",
        },
        remotePort: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Optional exact remote bridge port. Without it, ports 42671-42770 are scanned.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_ui",
    description: "Read the current App UIWindow/UIView tree directly from DebugBridge.",
    inputSchema: {
      type: "object",
      properties: {
        depth: {
          type: "integer",
          minimum: 0,
          description: "Optional tree depth limit.",
        },
        includeHidden: {
          type: "boolean",
          description: "Include hidden or transparent nodes. Defaults to false.",
        },
        maxNodes: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum nodes returned. Defaults to 2000.",
        },
        color: {
          type: "boolean",
          description: "Deprecated compatibility field; ignored.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_debug_page",
    description: "Get semantic page and registered actionable element IDs from the in-app DebugBridge, optionally saving an artifact.",
    inputSchema: {
      type: "object",
      properties: {
        expectedPageID: {
          type: "string",
          description: "Optional expected pageID. When provided, mismatch returns an error with the captured page payload.",
        },
        saveArtifact: {
          type: "boolean",
          description: "Save the captured page JSON to artifactDir. Defaults to false.",
        },
        artifactDir: {
          type: "string",
          description: "Directory for saved artifacts. Defaults to .devflow-ui/runtime.",
        },
        artifactPrefix: {
          type: "string",
          description: "Optional file prefix for saved artifacts.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to retry while the app is launching or transitioning. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Retry interval for transient /debug/page failures. Defaults to 300.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_runtime_node",
    description: "Read a live UIKit node by runtime anchor/accessibilityIdentifier via the in-app DebugBridge, optionally saving a runtime detail artifact.",
    inputSchema: {
      type: "object",
      properties: {
        anchor: {
          type: "string",
          description: "Runtime anchor to match against UIView.accessibilityIdentifier, for example figma.1739_13055.",
        },
        saveArtifact: {
          type: "boolean",
          description: "Save the captured runtime node JSON to artifactDir. Defaults to false.",
        },
        artifactDir: {
          type: "string",
          description: "Directory for saved artifacts. Defaults to .devflow-ui/runtime.",
        },
        artifactPrefix: {
          type: "string",
          description: "Optional file prefix for saved artifacts.",
        },
      },
      required: ["anchor"],
      additionalProperties: false,
    },
  },
  {
    name: "read_app_logs",
    description: "Search the current app run's in-memory DebugBridge log pool. Logs are temporary and are not written to disk or addressed by cursor.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring matched against log messages." },
        level: { type: "string", description: "Optional exact level filter, such as debug, info, or error." },
        category: { type: "string", description: "Optional exact category filter." },
        limit: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum most-recent matching entries. Defaults to 500." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait_app_logs",
    description: "Wait for a new matching entry in the current app run's in-memory DebugBridge log pool; no cursor is required or returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring matched against log messages." },
        level: { type: "string", description: "Optional exact level filter, such as debug, info, or error." },
        category: { type: "string", description: "Optional exact category filter." },
        limit: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum most-recent matching entries. Defaults to 500." },
        waitMs: { type: "integer", minimum: 1, maximum: 120000, description: "Maximum wait time. Defaults to 30000." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tap_element",
    description: "Tap an element by stable DebugBridge ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Debug element identifier, for example AutomationTest.primaryButton.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          description: "Delay after tap before reading the next page. Defaults to 350.",
        },
        waitForPageID: {
          type: "string",
          description: "Optional pageID to wait for after tap.",
        },
        waitForPageIDs: {
          type: "array",
          items: { type: "string" },
          description: "Optional acceptable pageIDs to wait for after tap.",
        },
        waitForElementID: {
          type: "string",
          description: "Optional element ID to wait for after tap.",
        },
        waitForLabel: {
          type: "string",
          description: "Optional exact element label to wait for after tap.",
        },
        waitForLabelIncludes: {
          type: "string",
          description: "Optional element label substring to wait for after tap.",
        },
        waitForElement: {
          type: "object",
          description: "Optional element criteria to wait for after tap.",
          properties: {
            id: { type: "string" },
            idIncludes: { type: "string" },
            label: { type: "string" },
            labelIncludes: { type: "string" },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to wait for post-tap page availability or target criteria. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Polling interval after tap. Defaults to 300.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_switch",
    description: "Set a UISwitch by stable DebugBridge ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Debug element identifier, for example AutomationTest.toggleSwitch.",
        },
        isOn: {
          type: "boolean",
          description: "Target switch state.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          description: "Delay after setting the switch before reading the next page. Defaults to 350.",
        },
        waitForPageID: {
          type: "string",
          description: "Optional pageID to wait for after changing the switch.",
        },
        waitForPageIDs: {
          type: "array",
          items: { type: "string" },
          description: "Optional acceptable pageIDs to wait for after changing the switch.",
        },
        waitForElementID: {
          type: "string",
          description: "Optional element ID to wait for after changing the switch.",
        },
        waitForLabel: {
          type: "string",
          description: "Optional exact element label to wait for after changing the switch.",
        },
        waitForLabelIncludes: {
          type: "string",
          description: "Optional element label substring to wait for after changing the switch.",
        },
        waitForElement: {
          type: "object",
          description: "Optional element criteria to wait for after changing the switch.",
          properties: {
            id: { type: "string" },
            idIncludes: { type: "string" },
            label: { type: "string" },
            labelIncludes: { type: "string" },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to wait for post-action page availability or target criteria. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Polling interval after changing the switch. Defaults to 300.",
        },
      },
      required: ["id", "isOn"],
      additionalProperties: false,
    },
  },
  {
    name: "set_text",
    description: "Replace text in a UITextField or UITextView by stable DebugBridge ID, focusing the control and firing editing-change events.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Debug element identifier, for example photoComment.input.",
        },
        text: {
          type: "string",
          description: "Exact text to set.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          description: "Delay after setting text before reading the next page. Defaults to 350.",
        },
        waitForPageID: {
          type: "string",
          description: "Optional pageID to wait for after setting text.",
        },
        waitForPageIDs: {
          type: "array",
          items: { type: "string" },
          description: "Optional acceptable pageIDs to wait for after setting text.",
        },
        waitForElementID: {
          type: "string",
          description: "Optional element ID to wait for after setting text.",
        },
        waitForLabel: {
          type: "string",
          description: "Optional exact element label to wait for after setting text.",
        },
        waitForLabelIncludes: {
          type: "string",
          description: "Optional element label substring to wait for after setting text.",
        },
        waitForElement: {
          type: "object",
          description: "Optional element criteria to wait for after setting text.",
          properties: {
            id: { type: "string" },
            idIncludes: { type: "string" },
            label: { type: "string" },
            labelIncludes: { type: "string" },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to wait for post-action page availability or target criteria. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Polling interval after setting text. Defaults to 300.",
        },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Append text to a UITextField or UITextView by stable DebugBridge ID, focusing the control and firing editing-change events.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Debug element identifier, for example photoComment.input.",
        },
        text: {
          type: "string",
          description: "Text to append.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          description: "Delay after typing text before reading the next page. Defaults to 350.",
        },
        waitForPageID: {
          type: "string",
          description: "Optional pageID to wait for after typing text.",
        },
        waitForPageIDs: {
          type: "array",
          items: { type: "string" },
          description: "Optional acceptable pageIDs to wait for after typing text.",
        },
        waitForElementID: {
          type: "string",
          description: "Optional element ID to wait for after typing text.",
        },
        waitForLabel: {
          type: "string",
          description: "Optional exact element label to wait for after typing text.",
        },
        waitForLabelIncludes: {
          type: "string",
          description: "Optional element label substring to wait for after typing text.",
        },
        waitForElement: {
          type: "object",
          description: "Optional element criteria to wait for after typing text.",
          properties: {
            id: { type: "string" },
            idIncludes: { type: "string" },
            label: { type: "string" },
            labelIncludes: { type: "string" },
            type: { type: "string" },
          },
          additionalProperties: false,
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to wait for post-action page availability or target criteria. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Polling interval after typing text. Defaults to 300.",
        },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "run_flow",
    description: "Run a UI operation flow against the current app page using DebugBridge IDs or labels.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          description: "Ordered UI steps. Supported actions: tap, tap_if_present, set_switch, set_text, type_text, wait_for_page, wait_for_element, sleep.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["tap", "tap_if_present", "set_switch", "set_text", "type_text", "wait_for_page", "wait_for_element", "sleep"],
              },
              id: {
                type: "string",
                description: "Exact DebugBridge element ID to target.",
              },
              idIncludes: {
                type: "string",
                description: "Substring of the DebugBridge element ID to target when exact id is not known.",
              },
              label: {
                type: "string",
                description: "Exact element label to target when id is not known.",
              },
              labelIncludes: {
                type: "string",
                description: "Substring of the element label to target when id is not known.",
              },
              type: {
                type: "string",
                description: "Optional element type filter, such as button or switch.",
              },
              isOn: {
                type: "boolean",
                description: "Target value for set_switch.",
              },
              text: {
                type: "string",
                description: "Text value for set_text or type_text.",
              },
              pageID: {
                type: "string",
                description: "Expected page ID for wait_for_page.",
              },
              pageIDs: {
                type: "array",
                items: { type: "string" },
                description: "Any acceptable page ID for wait_for_page.",
              },
              waitForPageID: {
                type: "string",
                description: "Optional page ID to wait for after tap or set_switch.",
              },
              waitForPageIDs: {
                type: "array",
                items: { type: "string" },
                description: "Optional acceptable page IDs to wait for after tap or set_switch.",
              },
              waitForElementID: {
                type: "string",
                description: "Optional element ID to wait for after tap or set_switch.",
              },
              waitForLabel: {
                type: "string",
                description: "Optional exact element label to wait for after tap or set_switch.",
              },
              waitForLabelIncludes: {
                type: "string",
                description: "Optional element label substring to wait for after tap or set_switch.",
              },
              waitForType: {
                type: "string",
                description: "Optional element type to wait for after tap or set_switch.",
              },
              waitForElement: {
                type: "object",
                description: "Optional element criteria to wait for after tap or set_switch.",
                properties: {
                  id: {
                    type: "string",
                    description: "Exact DebugBridge element ID.",
                  },
                  idIncludes: {
                    type: "string",
                    description: "Substring of the DebugBridge element ID.",
                  },
                  label: {
                    type: "string",
                    description: "Exact element label.",
                  },
                  labelIncludes: {
                    type: "string",
                    description: "Substring of the element label.",
                  },
                  type: {
                    type: "string",
                    description: "Element type, such as button or switch.",
                  },
                },
                additionalProperties: false,
              },
              timeoutMs: {
                type: "integer",
                minimum: 0,
                description: "Per-step timeout. Defaults to 5000.",
              },
              intervalMs: {
                type: "integer",
                minimum: 50,
                description: "Polling interval for wait steps. Defaults to 250.",
              },
              waitAfterMs: {
                type: "integer",
                minimum: 0,
                description: "Delay after tap or set_switch before reading the next page. Defaults to 350.",
              },
              ms: {
                type: "integer",
                minimum: 0,
                description: "Sleep duration for sleep action.",
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        saveArtifacts: {
          type: "boolean",
          description: "Save flow trace and final page JSON artifacts. Defaults to false.",
        },
        artifactDir: {
          type: "string",
          description: "Directory for saved artifacts. Defaults to .devflow-ui/runtime.",
        },
        artifactPrefix: {
          type: "string",
          description: "Optional file prefix for saved artifacts.",
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_runtime",
    description: "Compare a Figma raw frame with the current DebugBridge page and write semantic audit artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        figmaRawPath: {
          type: "string",
          description: "Path to the raw Figma JSON artifact.",
        },
        figmaNodeID: {
          type: "string",
          description: "Optional target Figma node id when the raw file contains multiple nodes.",
        },
        expectedPageID: {
          type: "string",
          description: "Optional expected DebugBridge pageID.",
        },
        labelAliases: {
          type: "object",
          description: "Optional label alias map, e.g. {\"Share\":[\"分享\"]}.",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        artifactDir: {
          type: "string",
          description: "Directory for JSON/Markdown report artifacts. Defaults to .devflow-ui/runtime.",
        },
        artifactPrefix: {
          type: "string",
          description: "Optional file prefix for saved report artifacts.",
        },
        outJsonPath: {
          type: "string",
          description: "Optional exact JSON artifact path.",
        },
        outMarkdownPath: {
          type: "string",
          description: "Optional exact Markdown artifact path.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          description: "How long to retry /debug/page while the app is launching or transitioning. Defaults to 8000.",
        },
        intervalMs: {
          type: "integer",
          minimum: 50,
          description: "Retry interval for transient /debug/page failures. Defaults to 300.",
        },
      },
      required: ["figmaRawPath"],
      additionalProperties: false,
    },
  },
  {
    name: "get_screenshot",
    description: "Capture a screenshot using the configured screenshot command.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_page",
    description: "Deprecated alias of get_debug_page.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_ui_hierarchy",
    description: "Deprecated alias of inspect_ui using the current App UIWindow/UIView tree.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function makeToolResult(source, result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            source,
            success: result.success,
            payload: result.payload ?? null,
            error: result.error ?? null,
          },
          null,
          2
        ),
      },
    ],
    isError: !result.success,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bridgeResultOK(result) {
  return result.ok && result.payload?.success !== false;
}

function bridgeError(result) {
  if (!result) {
    return "request_failed";
  }
  return result.payload?.error || `http_${result.status}`;
}

function requestedBridgeIdentity(args) {
  const bundleID = String(args?.bundleID || args?.appID || "").trim();
  const sessionID = String(args?.sessionID || "").trim();
  return {
    ...(bundleID ? { bundleID } : {}),
    ...(sessionID ? { sessionID } : {}),
  };
}

// 控制类工具执行前重新校验当前 bridge identity 是否仍匹配预期
// 不匹配则失败，防止用户在两次调用间切换 App/设备后误操作
async function verifyBridgeIdentity(expectedIdentity) {
  if (!expectedIdentity || (!expectedIdentity.bundleID && !expectedIdentity.sessionID)) {
    return { success: true };
  }
  let identityResult;
  try {
    identityResult = await bridgeClient.getIdentity();
  } catch (error) {
    return { success: false, error: `bridge_identity_check_failed:${error.message}` };
  }
  if (!identityResult?.ok || !identityResult?.payload) {
    return {
      success: false,
      error: `bridge_identity_unreachable:${bridgeError(identityResult)}`,
    };
  }
  if (!identityMatches(identityResult.payload, expectedIdentity)) {
    return { success: false, error: "bridge_target_mismatch_during_control" };
  }
  return { success: true };
}

// 包装可能抛异常的 bridge 调用，统一返回标准 tool result，避免上抛 JSON-RPC transport error
async function safeBridgeCall(source, fn) {
  try {
    const result = await fn();
    return makeToolResult(source, {
      success: bridgeResultOK(result),
      payload: result.payload,
      error: bridgeError(result),
    });
  } catch (error) {
    return makeToolResult(source, {
      success: false,
      payload: null,
      error: error.message,
    });
  }
}

// tools/call 全局串行队列：消除并发修改 config/bridgeClient/portForwards 的竞态
// 初始化响应仍立即返回，仅串行化 tools/call 业务处理
let toolsCallQueue = Promise.resolve();
function serializeToolsCall(handler) {
  const next = toolsCallQueue.then(handler, handler);
  // 队列指针始终跟进到下一次，即使本次失败也不阻塞后续
  toolsCallQueue = next.catch(() => {});
  return next;
}

function requestedRuntimeMode(args) {
  const mode = String(args?.mode || "auto").trim();
  return ["auto", "device"].includes(mode) ? mode : "auto";
}

function pageSummary(page) {
  if (!page) {
    return null;
  }
  return {
    pageID: page.pageID,
    title: page.title,
    elementCount: pageElements(page).length,
  };
}

function retrySummary(state) {
  return {
    attempts: state.attempts,
    transientFailures: state.transientFailures,
    lastError: state.lastError,
    lastStatus: state.lastStatus,
    lastPage: pageSummary(state.lastPage),
  };
}

async function getPageWithRetry({
  timeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  intervalMs = DEFAULT_PAGE_INTERVAL_MS,
  expectedPageID,
  acceptedPageIDs = [],
  predicate,
} = {}) {
  const startedAt = Date.now();
  const accepted = [expectedPageID, ...acceptedPageIDs].filter(Boolean);
  const state = {
    attempts: 0,
    transientFailures: 0,
    lastError: null,
    lastStatus: null,
    lastPage: null,
  };

  do {
    state.attempts += 1;
    try {
      const result = await bridgeClient.getPage();
      state.lastStatus = result.status;
      if (result.ok) {
        const page = result.payload;
        state.lastPage = page;
        const pageMatchesExpected =
          accepted.length === 0 || accepted.includes(page?.pageID);
        const predicateMatches = predicate ? Boolean(predicate(page)) : true;
        if (pageMatchesExpected && predicateMatches) {
          return {
            page,
            result,
            retry: retrySummary(state),
          };
        }
        state.lastError = accepted.length > 0 && !pageMatchesExpected
          ? `page_id_mismatch expected:${accepted.join("|")} actual:${page?.pageID ?? "unknown"}`
          : "page_predicate_mismatch";
      } else {
        state.transientFailures += 1;
        state.lastError = bridgeError(result);
      }
    } catch (error) {
      state.transientFailures += 1;
      state.lastError = error.message;
      state.lastStatus = null;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }
    await sleep(intervalMs);
  } while (true);

  const pageHint = state.lastPage?.pageID
    ? `last_page:${state.lastPage.pageID}`
    : "last_page:unavailable";
  const error = state.lastError || "debug_page_unavailable";
  const timeoutError = new Error(`debug_page_unavailable ${pageHint} error:${error}`);
  timeoutError.retry = retrySummary(state);
  throw timeoutError;
}

async function getPageOrThrow(options = {}) {
  const { page } = await getPageWithRetry(options);
  return page;
}

async function waitAfterActionAndReadPage(step) {
  const waitAfterMs = step.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS;
  if (waitAfterMs > 0) {
    await sleep(waitAfterMs);
  }
  return getPageWithRetry({
    timeoutMs: step.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
    intervalMs: step.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
  });
}

function pageElements(page) {
  return Array.isArray(page?.elements) ? page.elements : [];
}

function findElement(page, criteria = {}) {
  const elements = pageElements(page);
  return elements.find((element) => {
    if (criteria.id && element.id !== criteria.id) {
      return false;
    }
    if (criteria.idIncludes && !String(element.id ?? "").includes(criteria.idIncludes)) {
      return false;
    }
    if (criteria.label && element.label !== criteria.label) {
      return false;
    }
    if (criteria.labelIncludes && !String(element.label ?? "").includes(criteria.labelIncludes)) {
      return false;
    }
    if (criteria.type && element.type !== criteria.type) {
      return false;
    }
    return true;
  });
}

function targetCriteriaFromStep(step) {
  return {
    id: step.id,
    idIncludes: step.idIncludes,
    label: step.label,
    labelIncludes: step.labelIncludes,
    type: step.type,
  };
}

function waitCriteriaFromStep(step) {
  if (step.waitForElement) {
    return step.waitForElement;
  }
  if (step.waitForElementID) {
    return {
      id: step.waitForElementID,
      label: step.waitForLabel,
      labelIncludes: step.waitForLabelIncludes,
      type: step.waitForType,
    };
  }
  if (step.waitForLabel || step.waitForLabelIncludes || step.waitForType) {
    return {
      label: step.waitForLabel,
      labelIncludes: step.waitForLabelIncludes,
      type: step.waitForType,
    };
  }
  return null;
}

function pageMatches(currentPage, pageID, pageIDs = []) {
  const accepted = [pageID, ...pageIDs].filter(Boolean);
  if (accepted.length === 0) {
    return true;
  }
  return accepted.includes(currentPage?.pageID);
}

async function waitForPageMatch(predicate, { timeoutMs = 5000, intervalMs = 250 } = {}) {
  try {
    const { page } = await getPageWithRetry({ timeoutMs, intervalMs, predicate });
    return page;
  } catch (error) {
    throw new Error(`flow_wait_timeout ${error.message}`);
  }
}

async function runFlow(steps) {
  const trace = [];

  for (const [index, step] of steps.entries()) {
    const timeoutMs = step.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
    const intervalMs = step.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS;
    const action = step.action;

    if (action === "sleep") {
      await sleep(step.ms ?? 0);
      trace.push({ index, action, success: true, sleptMs: step.ms ?? 0 });
      continue;
    }

    if (action === "wait_for_page") {
      const page = await waitForPageMatch(
        (currentPage) => pageMatches(currentPage, step.pageID, step.pageIDs),
        { timeoutMs, intervalMs }
      );
      trace.push({ index, action, success: true, pageID: page.pageID, title: page.title });
      continue;
    }

    if (action === "wait_for_element") {
      const criteria = targetCriteriaFromStep(step);
      const page = await waitForPageMatch(
        (currentPage) => Boolean(findElement(currentPage, criteria)),
        { timeoutMs, intervalMs }
      );
      const element = findElement(page, criteria);
      trace.push({ index, action, success: true, pageID: page.pageID, element });
      continue;
    }

    if (
      action !== "tap" &&
      action !== "tap_if_present" &&
      action !== "set_switch" &&
      action !== "set_text" &&
      action !== "type_text"
    ) {
      throw new Error(`unsupported_flow_action:${action}`);
    }

    const page = await getPageOrThrow({ timeoutMs, intervalMs });
    const element = findElement(page, targetCriteriaFromStep(step));
    if (!element) {
      if (action === "tap_if_present") {
        trace.push({
          index,
          action,
          success: true,
          skipped: true,
          pageID: page.pageID,
          reason: "element_not_present",
        });
        continue;
      }
      throw new Error(`flow_element_not_found step:${index} page:${page.pageID}`);
    }

    let result;
    if (action === "set_switch") {
      result = await bridgeClient.setSwitch(element.id, step.isOn);
    } else if (action === "set_text") {
      result = await bridgeClient.setText(element.id, step.text ?? "");
    } else if (action === "type_text") {
      result = await bridgeClient.typeText(element.id, step.text ?? "");
    } else {
      result = await bridgeClient.tapElement(element.id);
    }

    if (!bridgeResultOK(result)) {
      throw new Error(`flow_${action}_failed step:${index} element:${element.id} error:${bridgeError(result)}`);
    }

    const traceItem = {
      index,
      action,
      success: true,
      pageID: page.pageID,
      element,
      response: result.payload,
    };

    if (step.waitForPageID || step.waitForPageIDs?.length) {
      if ((step.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
        await sleep(step.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
      }
      const nextPage = await waitForPageMatch(
        (currentPage) => pageMatches(currentPage, step.waitForPageID, step.waitForPageIDs),
        { timeoutMs, intervalMs }
      );
      traceItem.waitedFor = { pageID: nextPage.pageID, title: nextPage.title };
    } else {
      const waitCriteria = waitCriteriaFromStep(step);
      if (waitCriteria) {
        if ((step.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
          await sleep(step.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
        }
        const nextPage = await waitForPageMatch(
          (currentPage) => Boolean(findElement(currentPage, waitCriteria)),
          { timeoutMs, intervalMs }
        );
        traceItem.waitedFor = {
          pageID: nextPage.pageID,
          element: findElement(nextPage, waitCriteria),
        };
      } else {
        const { page: nextPage, retry } = await waitAfterActionAndReadPage(step);
        traceItem.waitedFor = {
          pageID: nextPage.pageID,
          title: nextPage.title,
          reason: "page_available",
          retry,
        };
      }
    }

    trace.push(traceItem);
  }

  const finalPage = await getPageOrThrow({
    timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    intervalMs: DEFAULT_PAGE_INTERVAL_MS,
  });
  return {
    success: true,
    trace,
    finalPage: {
      pageID: finalPage.pageID,
      title: finalPage.title,
      elementCount: pageElements(finalPage).length,
    },
  };
}

async function releaseSession(args = {}) {
  const exitAfterRelease = args.exitAfterRelease !== false;
  const releasedForwards = portForwarder.activeForwards();
  await portForwarder.stopAllAndWait();
  config.expectedBridgeIdentity = null;
  if (config.portForwards?.[0]) {
    config.portForwards[0].localPort = config.portForwards[0].autoAllocate ? 0 : config.portForwards[0].localPort;
  }

  const payload = {
    sessionID: config.sessionID,
    deviceUDID: config.deviceUDID || null,
    releasedForwards,
    reason: typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : null,
    exitAfterRelease,
  };

  if (exitAfterRelease) {
    setImmediate(() => {
      process.exit(0);
    });
  }

  return makeToolResult("release_session", {
    success: true,
    payload,
    error: null,
  });
}

async function dispatchTool(name, args) {
  // 顶层错误兜底：所有未捕获异常统一转为 tool result，避免上抛 JSON-RPC transport error
  try {
    return await dispatchToolInner(name, args);
  } catch (error) {
    return makeToolResult("dispatch_tool", {
      success: false,
      payload: null,
      error: error.message,
    });
  }
}

async function dispatchToolInner(name, args) {
  if (name === "release_session") {
    return releaseSession(args);
  }

  const listed = await runtimeTargetResolver.listAll(config);
  if (!listed.success || !Array.isArray(listed.payload?.targets) || listed.payload.targets.length === 0) {
    return makeToolResult("runtime_target_resolver", {
      success: false,
      payload: listed.payload,
      error: listed.error || "no_runtime_targets",
    });
  }

  const deviceTargets = listed.payload.targets.filter((target) => target.mode === "device");
  if (deviceTargets.length === 0) {
    return makeToolResult("runtime_target_resolver", {
      success: false,
      payload: listed.payload,
      error: "no_runtime_targets",
    });
  }

  const preferredMode = requestedRuntimeMode(args);
  const preferredDeviceUDID = String(args?.deviceUDID || "").trim();
  // 严格匹配生效条件：请求参数显式传了 deviceUDID，或环境变量 LOOKDEBUG_DEVICE_UDID 配置了 deviceUDID
  // 配置来源的 deviceUDID 也作为强制目标：无匹配活桥 → 直接失败，不静默回退到其他设备
  // 注意：必须在 applyRuntimeTarget 覆盖 config.deviceUDID 之前读取
  const configuredDeviceUDID = String(config.deviceUDID || "").trim();
  const strictDeviceUDID = preferredDeviceUDID.length > 0 || configuredDeviceUDID.length > 0;
  // 合并请求参数和环境变量的 deviceUDID：请求参数优先，否则用配置值
  // 这样 selectLiveBridge 的 preferredUDID 能匹配到配置的设备（applyRuntimeTarget 后 config.deviceUDID 已被覆盖）
  const effectivePreferredDeviceUDID = preferredDeviceUDID || configuredDeviceUDID;
  const defaultTarget = deviceTargets[0];
  applyRuntimeTarget(config, defaultTarget);

  const requestedIdentity = requestedBridgeIdentity(args);
  // 不复用上一次调用残留的 expectedBridgeIdentity：每次调用重新评估
  if (Object.keys(requestedIdentity).length > 0) {
    config.expectedBridgeIdentity = requestedIdentity;
  } else {
    config.expectedBridgeIdentity = null;
  }
  const expectedBridgeIdentity = config.expectedBridgeIdentity ?? null;
  const remotePortCandidates = Number.isInteger(args?.remotePort)
    ? [args.remotePort]
    : undefined;

  const preflight = await runEnvironmentPreflight({
    config,
    portForwarder,
    bridgeClient,
    targets: deviceTargets,
    runtimeTarget: defaultTarget,
    expectedIdentity: expectedBridgeIdentity,
    remotePortCandidates,
    preferredDeviceUDID: effectivePreferredDeviceUDID,
    strictDeviceUDID,
    preferredMode,
  });

  if (name === "ping" || preflight?.success === false) {
    return makeToolResult("lookdebug_environment_preflight", preflight);
  }

  // 控制类工具执行前重新校验目标 identity，防止切换 App/设备后误操作
  const isControlTool = name === "tap_element"
    || name === "set_switch"
    || name === "set_text"
    || name === "type_text"
    || name === "run_flow";
  if (isControlTool) {
    const verification = await verifyBridgeIdentity(expectedBridgeIdentity);
    if (!verification.success) {
      return makeToolResult("http_bridge", {
        success: false,
        payload: null,
        error: verification.error,
      });
    }
  }

  switch (name) {
    case "ensure_ports":
      return makeToolResult("lookdebug_environment_preflight", preflight);
    case "inspect_ui":
      // 读工具统一包装：网络/JSON 异常返回 tool result，不抛 transport error
      return safeBridgeCall("debug_bridge", () => bridgeClient.getWindowTree(args));
    case "read_app_logs":
    case "wait_app_logs":
      return safeBridgeCall("debug_bridge_logs", () => bridgeClient.readLogs({
        ...args,
        waitMs: name === "wait_app_logs" ? (args.waitMs ?? 30_000) : 0,
      }));
    case "get_debug_page":
    case "get_page": {
      let pageResult;
      try {
        pageResult = await getPageWithRetry({
          timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
          intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
          expectedPageID: args.expectedPageID,
        });
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: { retry: error.retry ?? null },
          error: error.message,
        });
      }
      const result = pageResult.result;
      let payload = { ...pageResult.page, retry: pageResult.retry };
      let artifactPath = null;
      if (args.saveArtifact) {
        artifactPath = await writeJSONArtifact(payload, {
          artifactDir: args.artifactDir,
          artifactPrefix: args.artifactPrefix || payload?.pageID || "debug-page",
          suffix: "debug-page",
        });
        payload = { ...payload, artifactPath };
      }
      return makeToolResult("http_bridge", {
        success: result.ok,
        payload,
        error: null,
      });
    }
    case "get_runtime_node": {
      // 网络异常统一捕获，返回 tool result
      let result;
      try {
        result = await bridgeClient.getRuntimeNode(args.anchor);
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
      let payload = result.payload;
      let artifactPath = null;
      if (args.saveArtifact && payload) {
        artifactPath = await writeJSONArtifact(payload, {
          artifactDir: args.artifactDir,
          artifactPrefix: args.artifactPrefix || args.anchor.replace(/[^A-Za-z0-9_.-]/g, "_"),
          suffix: "runtime-detail",
        });
        payload = { ...payload, artifactPath };
      }
      return makeToolResult("http_bridge", {
        success: result.ok && result.payload?.unique === true,
        payload,
        error: result.ok ? result.payload?.error ?? null : result.payload?.error || `http_${result.status}`,
      });
    }
    case "tap_element": {
      // 控制请求：bridgeClient.tapElement 网络异常统一捕获
      let result;
      try {
        result = await bridgeClient.tapElement(args.id);
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
      let nextPage = null;
      if (bridgeResultOK(result)) {
        try {
          const waitStep = { ...args };
          if (args.waitForPageID || args.waitForPageIDs?.length) {
            if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
              await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
            }
            const page = await waitForPageMatch(
              (currentPage) => pageMatches(currentPage, args.waitForPageID, args.waitForPageIDs),
              {
                timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
              }
            );
            nextPage = { ...pageSummary(page), reason: "wait_for_page" };
          } else {
            const waitCriteria = waitCriteriaFromStep(args);
            if (waitCriteria) {
              if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
                await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
              }
              const page = await waitForPageMatch(
                (currentPage) => Boolean(findElement(currentPage, waitCriteria)),
                {
                  timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                  intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
                }
              );
              nextPage = {
                ...pageSummary(page),
                reason: "wait_for_element",
                element: findElement(page, waitCriteria),
              };
            } else {
              const { page, retry } = await waitAfterActionAndReadPage(waitStep);
              nextPage = { ...pageSummary(page), reason: "page_available", retry };
            }
          }
        } catch (error) {
          return makeToolResult("http_bridge", {
            success: false,
            payload: { response: result.payload, retry: error.retry ?? null },
            error: `tap_succeeded_but_wait_failed ${error.message}`,
          });
        }
      }
      return makeToolResult("http_bridge", {
        success: result.ok && result.payload?.success !== false,
        payload: { response: result.payload, nextPage },
        error: result.ok ? result.payload?.error ?? null : result.payload?.error || `http_${result.status}`,
      });
    }
    case "set_switch": {
      // 控制请求：bridgeClient.setSwitch 网络异常统一捕获
      let result;
      try {
        result = await bridgeClient.setSwitch(args.id, args.isOn);
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
      let nextPage = null;
      if (bridgeResultOK(result)) {
        try {
          const waitStep = { ...args };
          if (args.waitForPageID || args.waitForPageIDs?.length) {
            if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
              await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
            }
            const page = await waitForPageMatch(
              (currentPage) => pageMatches(currentPage, args.waitForPageID, args.waitForPageIDs),
              {
                timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
              }
            );
            nextPage = { ...pageSummary(page), reason: "wait_for_page" };
          } else {
            const waitCriteria = waitCriteriaFromStep(args);
            if (waitCriteria) {
              if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
                await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
              }
              const page = await waitForPageMatch(
                (currentPage) => Boolean(findElement(currentPage, waitCriteria)),
                {
                  timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                  intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
                }
              );
              nextPage = {
                ...pageSummary(page),
                reason: "wait_for_element",
                element: findElement(page, waitCriteria),
              };
            } else {
              const { page, retry } = await waitAfterActionAndReadPage(waitStep);
              nextPage = { ...pageSummary(page), reason: "page_available", retry };
            }
          }
        } catch (error) {
          return makeToolResult("http_bridge", {
            success: false,
            payload: { response: result.payload, retry: error.retry ?? null },
            error: `set_switch_succeeded_but_wait_failed ${error.message}`,
          });
        }
      }
      return makeToolResult("http_bridge", {
        success: result.ok && result.payload?.success !== false,
        payload: { response: result.payload, nextPage },
        error: result.ok ? result.payload?.error ?? null : result.payload?.error || `http_${result.status}`,
      });
    }
    case "set_text":
    case "type_text": {
      // 控制请求：bridgeClient.setText/typeText 网络异常统一捕获
      let result;
      try {
        result = name === "set_text"
          ? await bridgeClient.setText(args.id, args.text)
          : await bridgeClient.typeText(args.id, args.text);
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
      let nextPage = null;
      if (bridgeResultOK(result)) {
        try {
          const waitStep = { ...args };
          if (args.waitForPageID || args.waitForPageIDs?.length) {
            if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
              await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
            }
            const page = await waitForPageMatch(
              (currentPage) => pageMatches(currentPage, args.waitForPageID, args.waitForPageIDs),
              {
                timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
              }
            );
            nextPage = { ...pageSummary(page), reason: "wait_for_page" };
          } else {
            const waitCriteria = waitCriteriaFromStep(args);
            if (waitCriteria) {
              if ((waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS) > 0) {
                await sleep(waitStep.waitAfterMs ?? DEFAULT_POST_ACTION_WAIT_MS);
              }
              const page = await waitForPageMatch(
                (currentPage) => Boolean(findElement(currentPage, waitCriteria)),
                {
                  timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
                  intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
                }
              );
              nextPage = {
                ...pageSummary(page),
                reason: "wait_for_element",
                element: findElement(page, waitCriteria),
              };
            } else {
              const { page, retry } = await waitAfterActionAndReadPage(waitStep);
              nextPage = { ...pageSummary(page), reason: "page_available", retry };
            }
          }
        } catch (error) {
          return makeToolResult("http_bridge", {
            success: false,
            payload: { response: result.payload, retry: error.retry ?? null },
            error: `${name}_succeeded_but_wait_failed ${error.message}`,
          });
        }
      }
      return makeToolResult("http_bridge", {
        success: result.ok && result.payload?.success !== false,
        payload: { response: result.payload, nextPage },
        error: result.ok ? result.payload?.error ?? null : result.payload?.error || `http_${result.status}`,
      });
    }
    case "run_flow": {
      try {
        const flow = await runFlow(args.steps);
        if (args.saveArtifacts) {
          const flowArtifactPath = await writeJSONArtifact(flow, {
            artifactDir: args.artifactDir,
            artifactPrefix: args.artifactPrefix || flow.finalPage?.pageID || "run-flow",
            suffix: "flow",
          });
          const finalPage = await getPageOrThrow({
            timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
            intervalMs: DEFAULT_PAGE_INTERVAL_MS,
          });
          const finalPageArtifactPath = await writeJSONArtifact(finalPage, {
            artifactDir: args.artifactDir,
            artifactPrefix: args.artifactPrefix || finalPage.pageID || "run-flow",
            suffix: "debug-page",
          });
          flow.artifacts = { flowArtifactPath, finalPageArtifactPath };
        }
        return makeToolResult("http_bridge", {
          success: true,
          payload: flow,
          error: null,
        });
      } catch (error) {
        return makeToolResult("http_bridge", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
    }
    case "audit_runtime": {
      try {
        // artifact 路径限制：figmaRawPath 读操作允许未配置 root，但写操作（artifactDir/outJsonPath/outMarkdownPath）必须位于 root 内
        const artifactRoot = config.artifactRoot || null;
        const figmaRawPathResolved = await assertArtifactPath(args.figmaRawPath, {
          root: artifactRoot,
          allowWrite: false,
        });
        // 输入文件大小限制，防止读入超大文件耗尽内存
        await assertFileSize(figmaRawPathResolved, MAX_FIGMA_RAW_BYTES);
        // audit_runtime 总会写 pageArtifact（writeJSONArtifact 无条件调用）
        // 未配置 root 时一律拒绝，无论是否传 artifactDir（默认 .devflow-ui/runtime 也不允许）
        if (!artifactRoot) {
          return makeToolResult("runtime_audit", {
            success: false,
            payload: null,
            error: "artifact_root_not_configured_for_write",
          });
        }
        // 写路径校验：artifactDir、outJsonPath、outMarkdownPath 都必须在 root 内
        // 配置了 root 但未传 artifactDir 时，默认使用 {root}/runtime，保证默认写路径也在 root 内
        const defaultArtifactDir = path.join(artifactRoot, "runtime");
        const artifactDirResolved = await assertArtifactPath(
          args.artifactDir || defaultArtifactDir,
          { root: artifactRoot, allowWrite: true }
        );
        const outJsonPathResolved = args.outJsonPath
          ? await assertArtifactPath(args.outJsonPath, { root: artifactRoot, allowWrite: true })
          : undefined;
        const outMarkdownPathResolved = args.outMarkdownPath
          ? await assertArtifactPath(args.outMarkdownPath, { root: artifactRoot, allowWrite: true })
          : undefined;

        const page = await getPageOrThrow({
          timeoutMs: args.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
          intervalMs: args.intervalMs ?? DEFAULT_PAGE_INTERVAL_MS,
        });
        if (args.expectedPageID && page.pageID !== args.expectedPageID) {
          return makeToolResult("runtime_audit", {
            success: false,
            payload: { pageID: page.pageID, title: page.title },
            error: `page_id_mismatch expected:${args.expectedPageID} actual:${page.pageID ?? "unknown"}`,
          });
        }
        const pageArtifactPath = await writeJSONArtifact(page, {
          artifactDir: artifactDirResolved,
          artifactPrefix: args.artifactPrefix || page.pageID || "runtime-audit",
          suffix: "debug-page",
        });
        const report = await buildRuntimeAuditReport({
          figmaRawPath: figmaRawPathResolved,
          figmaNodeID: args.figmaNodeID,
          page,
          expectedPageID: args.expectedPageID,
          labelAliases: args.labelAliases,
        });
        const reportArtifacts = await writeRuntimeAuditArtifacts(report, {
          artifactDir: artifactDirResolved,
          artifactPrefix: args.artifactPrefix || `${page.pageID || "page"}-runtime-audit`,
          outJsonPath: outJsonPathResolved,
          outMarkdownPath: outMarkdownPathResolved,
        });
        return makeToolResult("runtime_audit", {
          success: true,
          payload: {
            summary: report.summary,
            runtime: report.runtime,
            figma: report.figma,
            pageArtifactPath,
            ...reportArtifacts,
            needsMapping: report.comparison.filter((item) => item.status === "needs_mapping"),
            extraRuntimeCandidates: report.extra_runtime_candidates,
          },
          error: null,
        });
      } catch (error) {
        return makeToolResult("runtime_audit", {
          success: false,
          payload: null,
          error: error.message,
        });
      }
    }
    case "get_ui_hierarchy":
      // 读工具统一包装：网络/JSON 异常返回 tool result，不抛 transport error
      return safeBridgeCall("debug_bridge", () => bridgeClient.getWindowTree({ depth: 8, maxNodes: 2_000 }));
    case "get_screenshot":
      return makeToolResult("screenshot_command", await screenshotClient.getScreenshot());
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResponse(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

let buffer = Buffer.alloc(0);

async function handleMessage(message) {
  const { id, method, params } = message;

  try {
    switch (method) {
      case "initialize":
        writeResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "lookdebug-mcp",
            // 版本号从 package.json 读取，避免与 package.json 不一致
            version: PACKAGE_VERSION,
          },
          instructions: [
            "LookDebugBridge / lookdebug-mcp discovers DebugBridge on connected physical devices.",
            "ensure_ports/ping scan ports 42671-42770 on physical devices and return discovered bridges.",
            "Select a target with bundleID, sessionID, deviceUDID, and/or mode=device.",
            "When no selector is provided, prefer a live wired physical device bridge, otherwise any live device.",
            "This server never scans iOS Simulator or localhost bridges.",
            "App launch/install uses XcodeBuildMCP; this server owns DebugBridge UI/actions/logs after the app is running.",
          ].join(" "),
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        writeResponse(id, { tools });
        return;
      case "tools/call":
        // tools/call 通过全局 promise 队列串行执行，消除并发修改 config/bridgeClient 的竞态
        // 初始化响应仍立即返回，仅串行化 tools/call 业务处理
        writeResponse(id, await serializeToolsCall(() => dispatchTool(params.name, params.arguments || {})));
        return;
      default:
        writeError(id ?? null, -32601, `method_not_found:${method}`);
    }
  } catch (error) {
    writeError(id ?? null, -32000, error.message);
  }
}

// 校验 JSON-RPC 消息结构：jsonrpc=="2.0"、method 是字符串、params 是对象（可选）、id 合法
function validateJSONRPCMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "invalid_request:not_an_object";
  }
  if (message.jsonrpc !== "2.0") {
    return "invalid_request:jsonrpc_not_2_0";
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    return "invalid_request:method_not_string";
  }
  if (message.params !== undefined && message.params !== null) {
    if (typeof message.params !== "object" || Array.isArray(message.params)) {
      return "invalid_request:params_not_object";
    }
  }
  // id 可选：字符串/数字/null；通知无 id 字段
  if (message.id !== undefined && message.id !== null) {
    if (typeof message.id !== "string" && typeof message.id !== "number") {
      return "invalid_request:id_invalid_type";
    }
  }
  return null;
}

// 处理单条已切片的消息字节：JSON.parse + 结构校验 + 派发
// 任何解析/校验失败都返回 JSON-RPC error，不上抛异常杀进程
function parseAndDispatch(messageBytes) {
  let message;
  try {
    message = JSON.parse(messageBytes.toString("utf8"));
  } catch (error) {
    // 非法 JSON：返回 -32700 Parse error
    writeError(null, -32700, `parse_error:${error.message}`);
    return;
  }

  const validationError = validateJSONRPCMessage(message);
  if (validationError) {
    // 结构不合法：返回 -32602 Invalid params / -32600 Invalid request
    writeError(message?.id ?? null, -32602, validationError);
    return;
  }

  void handleMessage(message);
}

function consumeBuffer() {
  while (true) {
    const firstByte = buffer.findIndex((byte) => ![9, 10, 13, 32].includes(byte));
    if (firstByte === -1) {
      buffer = Buffer.alloc(0);
      return;
    }
    if (firstByte > 0) {
      buffer = buffer.slice(firstByte);
    }

    if (buffer[0] === 0x7b) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        // 消息大小上限：超限返回 -32602 并丢弃，防止恶意/异常大消息耗尽内存
        if (buffer.length > MAX_MESSAGE_BYTES) {
          const oversized = buffer.length;
          buffer = Buffer.alloc(0);
          writeError(null, -32602, `message_too_large:${oversized}>${MAX_MESSAGE_BYTES}`);
          return;
        }
        return;
      }
      const messageBytes = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      // 消息大小上限校验
      if (messageBytes.length > MAX_MESSAGE_BYTES) {
        writeError(null, -32602, `message_too_large:${messageBytes.length}>${MAX_MESSAGE_BYTES}`);
        continue;
      }
      parseAndDispatch(messageBytes);
      continue;
    }

    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      // 累积超过上限仍未找到分隔符，丢弃并返回错误
      if (buffer.length > MAX_MESSAGE_BYTES) {
        const oversized = buffer.length;
        buffer = Buffer.alloc(0);
        writeError(null, -32602, `header_too_large:${oversized}>${MAX_MESSAGE_BYTES}`);
      }
      return;
    }

    const headerText = buffer.slice(0, separatorIndex).toString("utf8");
    const contentLengthLine = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!contentLengthLine) {
      // 缺少 Content-Length：丢弃此消息并返回 -32602，不杀进程
      buffer = buffer.slice(separatorIndex + 4);
      writeError(null, -32602, "missing_content_length");
      continue;
    }

    const contentLengthValue = contentLengthLine.split(":")[1].trim();
    const contentLength = Number.parseInt(contentLengthValue, 10);
    // Content-Length 必须是非负有限整数
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      buffer = buffer.slice(separatorIndex + 4);
      writeError(null, -32602, `invalid_content_length:${contentLengthValue}`);
      continue;
    }
    // 消息大小上限校验
    if (contentLength > MAX_MESSAGE_BYTES) {
      const messageStart = separatorIndex + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length >= messageEnd) {
        buffer = buffer.slice(messageEnd);
      } else {
        // 消息体尚未完整接收，但已超限，直接清空 buffer
        buffer = Buffer.alloc(0);
      }
      writeError(null, -32602, `message_too_large:${contentLength}>${MAX_MESSAGE_BYTES}`);
      continue;
    }
    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const messageBytes = buffer.slice(messageStart, messageEnd);
    buffer = buffer.slice(messageEnd);
    parseAndDispatch(messageBytes);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consumeBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});
