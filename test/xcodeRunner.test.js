import assert from "node:assert/strict";
import test from "node:test";

import { XcodeRunner } from "../src/xcodeRunner.js";

test("runActiveScheme activates Xcode and sends the current scheme shortcut", async () => {
  let received;
  const runner = new XcodeRunner({
    runScript: async (options) => {
      received = options;
      return {
        source: "xcode_active_scheme_runner",
        status: "command_r_sent",
        frontmost: true,
        windowCount: 1,
      };
    },
  });

  const result = await runner.runActiveScheme({ activateDelayMs: 99999 });
  assert.equal(result.success, true);
  assert.equal(received.activateDelayMs, 5000);
  assert.equal(received.windowReadyTimeoutMs, 8000);
  assert.equal(received.windowReadyIntervalMs, 250);
  assert.equal(result.payload.status, "command_r_sent");
});

test("runActiveScheme accepts longer Xcode window readiness timing", async () => {
  let received;
  const runner = new XcodeRunner({
    runScript: async (options) => {
      received = options;
      return {
        source: "xcode_active_scheme_runner",
        status: "command_r_sent",
        frontmost: true,
        windowCount: 1,
      };
    },
  });

  const result = await runner.runActiveScheme({
    windowReadyTimeoutMs: 12000,
    windowReadyIntervalMs: 750,
  });
  assert.equal(result.success, true);
  assert.equal(received.windowReadyTimeoutMs, 12000);
  assert.equal(received.windowReadyIntervalMs, 750);
});

test("runActiveScheme exposes stable Xcode automation errors", async () => {
  const runner = new XcodeRunner({
    runScript: async () => {
      const error = new Error("osascript failed");
      error.stderr = "Error: xcode_not_running";
      throw error;
    },
  });

  const result = await runner.runActiveScheme();
  assert.equal(result.success, false);
  assert.equal(result.error, "xcode_not_running");
});
