import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDevicectlDevices,
  selectRuntimeTarget,
  RuntimeTargetResolver,
} from "../src/runtimeTarget.js";

function physicalDevice(overrides = {}) {
  return {
    identifier: "core-device-1",
    connectionProperties: {
      tunnelState: "connected",
      transportType: "wired",
    },
    deviceProperties: {
      name: "iPhone 11",
      developerModeStatus: "enabled",
      ddiServicesAvailable: true,
      osVersionNumber: "26.5",
    },
    hardwareProperties: {
      reality: "physical",
      platform: "iOS",
      udid: "device-1",
      marketingName: "iPhone 11",
    },
    ...overrides,
  };
}

test("devicectl JSON parsing reads result.devices", () => {
  assert.deepEqual(parseDevicectlDevices(JSON.stringify({ result: { devices: [physicalDevice()] } })).length, 1);
});

test("a usable physical device wins over an explicitly requested simulator", () => {
  const target = selectRuntimeTarget({
    devices: [physicalDevice()],
    requestedMode: "simulator",
  });

  assert.equal(target.mode, "device");
  assert.equal(target.deviceUDID, "device-1");
  assert.equal(target.selectionReason, "physical_device_precedes_requested_simulator");
});

test("the configured physical device is selected when more than one device is usable", () => {
  const target = selectRuntimeTarget({
    devices: [
      physicalDevice(),
      physicalDevice({
        identifier: "core-device-2",
        hardwareProperties: { ...physicalDevice().hardwareProperties, udid: "device-2" },
      }),
    ],
    requestedMode: "auto",
    requestedDeviceUDID: "device-2",
  });

  assert.equal(target.deviceUDID, "device-2");
  assert.equal(target.selectionReason, "configured_physical_device");
});

test("simulator is selected only when no usable physical device exists", () => {
  const target = selectRuntimeTarget({
    devices: [physicalDevice({ connectionProperties: { tunnelState: "unavailable" } })],
    requestedMode: "auto",
  });

  assert.equal(target.mode, "simulator");
  assert.equal(target.fallbackReason, "no_connected_physical_device_with_developer_services");
});

test("resolver reports devicectl failures instead of silently falling back", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async () => {
      throw new Error("xcrun_missing");
    },
  });

  const result = await resolver.resolve({ requestedLookinMode: "auto", deviceUDID: "" });
  assert.equal(result.success, false);
  assert.match(result.error, /physical_device_detection_failed:xcrun_missing/);
});
