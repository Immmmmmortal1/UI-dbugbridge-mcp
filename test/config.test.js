import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("config defaults to automatic local port allocation", () => {
  const config = loadConfig({});

  assert.equal(config.portForwards[0].localPort, 0);
  assert.equal(config.portForwards[0].autoAllocate, true);
  assert.equal(config.bridgeBaseURLPortAuto, true);
  assert.ok(config.portForwards[0].remotePort >= 42000);
  assert.ok(config.portForwards[0].remotePort < 44000);
});

test("apps start at the first dynamic bridge port and can opt into an assigned port", () => {
  const first = loadConfig({ LOOKDEBUG_DEVICE_UDID: "device-1" });
  const second = loadConfig({ LOOKDEBUG_DEVICE_UDID: "device-2", DEV_FLOW_SESSION_ID: "other-task" });

  assert.equal(first.portForwards[0].remotePort, 42671);
  assert.equal(second.portForwards[0].remotePort, 42671);
  assert.equal(loadConfig({ BRIDGE_REMOTE_PORT: "42672" }).portForwards[0].remotePort, 42672);
});

test("config session id prefers Cursor conversation id before local fallback", () => {
  const config = loadConfig({
    CURSOR_CONVERSATION_ID: "bd225fc5-4f36-47e2-876e-8d9d125033a1",
  });
  assert.equal(config.sessionID, "bd225fc5-4f36-47e2-876e-8d9d125033a1");
});

test("explicit local port remains opt-in and is not auto-allocated", () => {
  const config = loadConfig({ BRIDGE_BASE_URL: "http://127.0.0.1:42671", BRIDGE_LOCAL_PORT: "40000" });

  assert.equal(config.portForwards[0].localPort, 40000);
  assert.equal(config.portForwards[0].autoAllocate, false);
  assert.equal(config.bridgeBaseURL, "http://127.0.0.1:40000");
});
