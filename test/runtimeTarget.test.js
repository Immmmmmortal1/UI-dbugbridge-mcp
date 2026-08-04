import assert from "node:assert/strict";
import test from "node:test";

import {
  createLegacyDevices,
  parseDevicectlDevices,
  parseLegacyDeviceUDIDs,
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

test("legacy device parsing creates wired physical targets without CoreDevice services", () => {
  assert.deepEqual(parseLegacyDeviceUDIDs("legacy-1\nlegacy-2\n"), ["legacy-1", "legacy-2"]);

  const [device] = createLegacyDevices("legacy-1\n");
  assert.equal(device.backend, "legacy");
  assert.equal(device.hardwareProperties.udid, "legacy-1");
  assert.equal(device.connectionProperties.transportType, "wired");
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

test("defaults to the first wired usable physical device before wireless devices", () => {
  const target = selectRuntimeTarget({
    devices: [
      physicalDevice({
        identifier: "core-device-wireless",
        connectionProperties: {
          tunnelState: "connected",
          transportType: "localNetwork",
        },
        hardwareProperties: { ...physicalDevice().hardwareProperties, udid: "device-wireless" },
      }),
      physicalDevice({
        identifier: "core-device-wired",
        connectionProperties: {
          tunnelState: "connected",
          transportType: "wired",
        },
        hardwareProperties: { ...physicalDevice().hardwareProperties, udid: "device-wired" },
      }),
    ],
    requestedMode: "auto",
  });

  assert.equal(target.deviceUDID, "device-wired");
  assert.equal(target.selectionReason, "first_wired_usable_physical_device");
});

test("selects a legacy device when it is the only usable physical target", () => {
  const [legacyDevice] = createLegacyDevices("legacy-1\n");
  const target = selectRuntimeTarget({
    devices: [legacyDevice],
    requestedMode: "auto",
  });

  assert.equal(target.mode, "device");
  assert.equal(target.deviceUDID, "legacy-1");
  assert.equal(target.device.backend, "legacy");
  assert.equal(target.selectionReason, "first_wired_usable_physical_device");
});

test("resolver de-duplicates a device reported by both backends", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async (command) => {
      if (command === "xcrun") {
        return {
          stdout: JSON.stringify({
            result: {
              devices: [physicalDevice({ hardwareProperties: { ...physicalDevice().hardwareProperties, udid: "same-1" } })],
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "same-1\n", stderr: "" };
    },
  });

  const result = await resolver.resolve({ deviceUDID: "" });
  assert.equal(result.success, true);
  assert.equal(result.payload.physicalDeviceCount, 1);
  assert.equal(result.payload.backend, "coredevice");
});

test("simulator is selected only when no usable physical device exists", () => {
  const target = selectRuntimeTarget({
    devices: [physicalDevice({ connectionProperties: { tunnelState: "unavailable" } })],
    requestedMode: "auto",
  });

  assert.equal(target.mode, "simulator");
  assert.equal(target.fallbackReason, "no_connected_physical_device_with_developer_services");
});

test("resolver falls back to legacy when CoreDevice detection fails", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async (command) => {
      if (command === "xcrun") {
        throw new Error("devicectl_unavailable");
      }
      return { stdout: "legacy-1\n", stderr: "" };
    },
  });

  const result = await resolver.resolve({ deviceUDID: "" });
  assert.equal(result.success, true);
  assert.equal(result.payload.deviceUDID, "legacy-1");
  assert.equal(result.payload.device.backend, "legacy");
});

test("resolver falls back when CoreDevice lists a device without usable services", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async (command) => {
      if (command === "xcrun") {
        return {
          stdout: JSON.stringify({
            result: {
              devices: [physicalDevice({
                connectionProperties: { tunnelState: "unavailable", transportType: "wired" },
                deviceProperties: {
                  ...physicalDevice().deviceProperties,
                  ddiServicesAvailable: false,
                },
                hardwareProperties: { ...physicalDevice().hardwareProperties, udid: "legacy-1" },
              })],
            },
          }),
          stderr: "",
        };
      }
      return { stdout: "legacy-1\n", stderr: "" };
    },
  });

  const result = await resolver.resolve({ deviceUDID: "legacy-1" });
  assert.equal(result.success, true);
  assert.equal(result.payload.deviceUDID, "legacy-1");
  assert.equal(result.payload.backend, "legacy");
});

test("resolver prefers a requested legacy device over another CoreDevice target", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async (command) => {
      if (command === "xcrun") {
        return { stdout: JSON.stringify({ result: { devices: [physicalDevice()] } }), stderr: "" };
      }
      return { stdout: "legacy-1\n", stderr: "" };
    },
  });

  const result = await resolver.resolve({ deviceUDID: "legacy-1" });
  assert.equal(result.success, true);
  assert.equal(result.payload.deviceUDID, "legacy-1");
  assert.equal(result.payload.device.backend, "legacy");
  assert.equal(result.payload.selectionReason, "configured_physical_device");
});

test("resolver reports both detection failures when neither backend is available", async () => {
  const resolver = new RuntimeTargetResolver({
    execFileImpl: async (command) => {
      throw new Error(`${command}_missing`);
    },
  });

  const result = await resolver.resolve({ deviceUDID: "" });
  assert.equal(result.success, false);
  assert.match(result.error, /physical_device_detection_failed:devicectl:xcrun_missing/);
  assert.match(result.error, /idevice_id:idevice_id_missing/);
});
