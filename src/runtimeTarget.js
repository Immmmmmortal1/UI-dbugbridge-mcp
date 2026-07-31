import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isConnectedUsablePhysicalDevice(device) {
  return device?.hardwareProperties?.reality === "physical"
    && device?.hardwareProperties?.platform === "iOS"
    && device?.connectionProperties?.tunnelState === "connected"
    && device?.deviceProperties?.developerModeStatus === "enabled"
    && device?.deviceProperties?.ddiServicesAvailable === true;
}

function deviceIdentity(device) {
  return device?.hardwareProperties?.udid || device?.identifier || null;
}

function summarizeDevice(device) {
  return {
    name: device?.deviceProperties?.name || device?.hardwareProperties?.marketingName || "iOS device",
    deviceUDID: deviceIdentity(device),
    coreDeviceID: device?.identifier || null,
    osVersion: device?.deviceProperties?.osVersionNumber || null,
    transport: device?.connectionProperties?.transportType || null,
  };
}

export function parseDevicectlDevices(stdout) {
  const payload = JSON.parse(stdout);
  const devices = payload?.result?.devices;
  return Array.isArray(devices) ? devices : [];
}

export function selectRuntimeTarget({ devices, requestedMode = "auto", requestedDeviceUDID = "" }) {
  const usablePhysicalDevices = devices.filter(isConnectedUsablePhysicalDevice);
  if (usablePhysicalDevices.length > 0) {
    const configured = usablePhysicalDevices.find((device) => {
      const identity = deviceIdentity(device);
      return identity === requestedDeviceUDID
        || device?.identifier === requestedDeviceUDID
        || device?.hardwareProperties?.udid === requestedDeviceUDID;
    });
    const selected = configured || usablePhysicalDevices[0];
    return {
      mode: "device",
      deviceUDID: deviceIdentity(selected),
      selectionReason: configured
        ? "configured_physical_device"
        : requestedMode === "simulator"
          ? "physical_device_precedes_requested_simulator"
          : requestedDeviceUDID
            ? "configured_device_unavailable_selected_first_usable_physical_device"
            : "first_usable_physical_device",
      fallbackReason: null,
      physicalDeviceCount: usablePhysicalDevices.length,
      device: summarizeDevice(selected),
    };
  }

  return {
    mode: "simulator",
    deviceUDID: "",
    selectionReason: "no_usable_physical_device",
    fallbackReason: "no_connected_physical_device_with_developer_services",
    physicalDeviceCount: 0,
    device: null,
  };
}

export class RuntimeTargetResolver {
  constructor({ execFileImpl = execFileAsync } = {}) {
    this.execFileImpl = execFileImpl;
  }

  async resolve(config) {
    try {
      const { stdout } = await this.execFileImpl(
        "xcrun",
        ["devicectl", "list", "devices", "--json-output", "-"],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }
      );
      const devices = parseDevicectlDevices(stdout);
      const target = selectRuntimeTarget({
        devices,
        requestedMode: "device",
        requestedDeviceUDID: config.deviceUDID,
      });
      if (target.mode !== "device") {
        return {
          success: false,
          payload: target,
          error: "physical_device_required",
        };
      }
      return {
        success: true,
        payload: target,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        payload: null,
        error: `physical_device_detection_failed:${error?.message || "devicectl_failed"}`,
      };
    }
  }
}

export function applyRuntimeTarget(config, target) {
  config.deviceUDID = target.deviceUDID;
  config.runtimeTarget = target;
  return config;
}
