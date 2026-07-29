import { loadConfig } from "./config.js";
import { runEnvironmentPreflight } from "./environmentPreflight.js";
import { HTTPBridgeClient } from "./httpBridgeClient.js";
import { LookinClient } from "./lookinClient.js";
import { PortForwarder } from "./portForwarder.js";
import { XcodeConsoleReader } from "./xcodeConsoleReader.js";
import { XcodeRunner } from "./xcodeRunner.js";
import {
  buildRuntimeAuditReport,
  writeJSONArtifact,
  writeRuntimeAuditArtifacts,
} from "./runtimeAudit.js";

const config = loadConfig();
const bridgeClient = new HTTPBridgeClient({ baseURL: config.bridgeBaseURL });
const lookinClient = new LookinClient(config);
const portForwarder = new PortForwarder(config);
const xcodeConsoleReader = new XcodeConsoleReader();
const xcodeRunner = new XcodeRunner();

const DEFAULT_PAGE_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_INTERVAL_MS = 300;
const DEFAULT_POST_ACTION_WAIT_MS = 350;
const DEFAULT_XCODE_READY_TIMEOUT_MS = 60000;
const DEFAULT_XCODE_READY_INTERVAL_MS = 1000;
const DEFAULT_XCODE_READY_QUERY = "LookDebugBridge ready";
const PREFLIGHT_BOOTSTRAP_TOOLS = new Set([
  "ensure_ports",
  "read_xcode_console",
  "wait_xcode_console",
  "run_xcode_active_scheme",
]);

const tools = [
  {
    name: "ping",
    description: "Check whether Lookin CLI and the in-app DebugBridge are reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ensure_ports",
    description: "Ensure local iproxy port forwards for LookinServer and DebugBridge in device mode.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "run_xcode_active_scheme",
    description: "Bring Xcode to the front and run the currently selected scheme with Command+R, keeping Xcode Console/Debugger in the same user-visible session.",
    inputSchema: {
      type: "object",
      properties: {
        activateDelayMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Delay after activating Xcode before sending Command+R. Defaults to 500.",
        },
        waitForReady: {
          type: "boolean",
          description: "Wait for a fresh Xcode Console ready marker after Command+R. Defaults to true.",
        },
        readyQuery: {
          type: "string",
          description: "Console substring that proves the debug runtime started. Defaults to LookDebugBridge ready.",
        },
        readyTimeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: 120000,
          description: "Maximum time to wait for readyQuery. Defaults to 60000.",
        },
        readyIntervalMs: {
          type: "integer",
          minimum: 250,
          maximum: 10000,
          description: "Polling interval while waiting for readyQuery. Defaults to 1000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_ui",
    description: "Read the visible UI hierarchy via lookin-cli.",
    inputSchema: {
      type: "object",
      properties: {
        depth: {
          type: "integer",
          minimum: 0,
          description: "Optional tree depth limit.",
        },
        filter: {
          type: "string",
          description: "Optional class-name filter passed to lookin-cli.",
        },
        json: {
          type: "boolean",
          description: "Request JSON output from lookin-cli when supported.",
        },
        raw: {
          type: "boolean",
          description: "Request raw hierarchy data from lookin-cli.",
        },
        color: {
          type: "boolean",
          description: "Keep ANSI color codes in text output. Defaults to false.",
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
    name: "run_flow",
    description: "Run a UI operation flow against the current app page using DebugBridge IDs or labels.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          description: "Ordered UI steps. Supported actions: tap, tap_if_present, set_switch, wait_for_page, wait_for_element, sleep.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["tap", "tap_if_present", "set_switch", "wait_for_page", "wait_for_element", "sleep"],
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
    name: "read_xcode_console",
    description: "Read and filter the existing Xcode Debug Console on demand without duplicating or persisting logs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring. Returns the most recent matches." },
        tailLines: { type: "integer", minimum: 1, maximum: 2000, description: "Lines returned when query is absent. Defaults to 100." },
        maxResults: { type: "integer", minimum: 1, maximum: 500, description: "Maximum matching lines. Defaults to 100." },
        maxCharsPerLine: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum characters returned per line. Defaults to 2000." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait_xcode_console",
    description: "Wait for new Xcode Debug Console lines after the call starts; stores only a transient character offset.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring to wait for." },
        tailLines: { type: "integer", minimum: 1, maximum: 2000, description: "New lines returned when query is absent. Defaults to 100." },
        maxResults: { type: "integer", minimum: 1, maximum: 500, description: "Maximum matching lines. Defaults to 100." },
        maxCharsPerLine: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum characters returned per line. Defaults to 2000." },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000, description: "Maximum wait time. Defaults to 30000." },
        intervalMs: { type: "integer", minimum: 250, maximum: 10000, description: "Polling interval. Defaults to 1000." },
      },
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
    description: "Deprecated alias of inspect_ui with json=true.",
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

    if (action !== "tap" && action !== "tap_if_present" && action !== "set_switch") {
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

    const result =
      action === "set_switch"
        ? await bridgeClient.setSwitch(element.id, step.isOn)
        : await bridgeClient.tapElement(element.id);

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

async function dispatchTool(name, args) {
  const shouldRunPreflight = name === "ping" || !PREFLIGHT_BOOTSTRAP_TOOLS.has(name);
  const preflight = shouldRunPreflight
    ? await runEnvironmentPreflight({
        config,
        portForwarder,
        bridgeClient,
        lookinClient,
        xcodeConsoleReader,
      })
    : null;

  if (name === "ping" || preflight?.success === false) {
    return makeToolResult("lookdebug_environment_preflight", preflight);
  }

  switch (name) {
    case "ensure_ports":
      return makeToolResult("iproxy", await portForwarder.ensureAll());
    case "run_xcode_active_scheme": {
      const runResult = await xcodeRunner.runActiveScheme(args);
      if (!runResult.success || args.waitForReady === false) {
        return makeToolResult("xcode_active_scheme_runner", runResult);
      }

      const readyResult = await xcodeConsoleReader.wait({
        query: args.readyQuery || DEFAULT_XCODE_READY_QUERY,
        timeoutMs: args.readyTimeoutMs ?? DEFAULT_XCODE_READY_TIMEOUT_MS,
        intervalMs: args.readyIntervalMs ?? DEFAULT_XCODE_READY_INTERVAL_MS,
        maxResults: 20,
        maxCharsPerLine: 4000,
      });
      const readyMatched = readyResult.success && readyResult.payload?.status === "matched";
      return makeToolResult("xcode_active_scheme_runner", {
        success: readyMatched,
        payload: {
          run: runResult.payload,
          ready: readyResult.payload,
        },
        error: readyMatched ? null : readyResult.error || "xcode_run_ready_marker_timeout",
      });
    }
    case "read_xcode_console":
      return makeToolResult("xcode_debug_console", await xcodeConsoleReader.read(args));
    case "wait_xcode_console":
      return makeToolResult("xcode_debug_console", await xcodeConsoleReader.wait(args));
    case "inspect_ui":
      return makeToolResult("lookin_cli", await lookinClient.getUIHierarchy(args));
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
    case "tap_element": {
      const result = await bridgeClient.tapElement(args.id);
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
      const result = await bridgeClient.setSwitch(args.id, args.isOn);
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
          artifactDir: args.artifactDir,
          artifactPrefix: args.artifactPrefix || page.pageID || "runtime-audit",
          suffix: "debug-page",
        });
        const report = await buildRuntimeAuditReport({
          figmaRawPath: args.figmaRawPath,
          figmaNodeID: args.figmaNodeID,
          page,
          expectedPageID: args.expectedPageID,
          labelAliases: args.labelAliases,
        });
        const reportArtifacts = await writeRuntimeAuditArtifacts(report, {
          artifactDir: args.artifactDir,
          artifactPrefix: args.artifactPrefix || `${page.pageID || "page"}-runtime-audit`,
          outJsonPath: args.outJsonPath,
          outMarkdownPath: args.outMarkdownPath,
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
      return makeToolResult("lookin_cli", await lookinClient.getUIHierarchy({ json: true }));
    case "get_screenshot":
      return makeToolResult("screenshot_command", await lookinClient.getScreenshot());
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
            version: "0.1.0",
          },
        });
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        writeResponse(id, { tools });
        return;
      case "tools/call":
        writeResponse(id, await dispatchTool(params.name, params.arguments || {}));
        return;
      default:
        writeError(id ?? null, -32601, `method_not_found:${method}`);
    }
  } catch (error) {
    writeError(id ?? null, -32000, error.message);
  }
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
        return;
      }
      const messageBytes = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const message = JSON.parse(messageBytes.toString("utf8"));
      void handleMessage(message);
      continue;
    }

    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }

    const headerText = buffer.slice(0, separatorIndex).toString("utf8");
    const contentLengthLine = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!contentLengthLine) {
      throw new Error("missing_content_length");
    }

    const contentLength = Number(contentLengthLine.split(":")[1].trim());
    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const messageBytes = buffer.slice(messageStart, messageEnd);
    buffer = buffer.slice(messageEnd);
    const message = JSON.parse(messageBytes.toString("utf8"));
    void handleMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consumeBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});
