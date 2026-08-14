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

function isUsableLegacyPhysicalDevice(device) {
  return device?.backend === "legacy"
    && device?.hardwareProperties?.reality === "physical"
    && device?.hardwareProperties?.platform === "iOS"
    && typeof device?.hardwareProperties?.udid === "string"
    && device.hardwareProperties.udid.length > 0;
}

function isUsablePhysicalDevice(device) {
  return isConnectedUsablePhysicalDevice(device) || isUsableLegacyPhysicalDevice(device);
}

function isWiredPhysicalDevice(device) {
  return String(device?.connectionProperties?.transportType || "").toLowerCase() === "wired";
}

function preferWiredUsablePhysicalDevices(devices) {
  const wired = devices.filter(isWiredPhysicalDevice);
  return wired.length > 0 ? wired : devices;
}

function deviceIdentity(device) {
  return device?.hardwareProperties?.udid || device?.deviceUDID || device?.identifier || null;
}

function summarizeDevice(device) {
  return {
    name: device?.deviceProperties?.name || device?.hardwareProperties?.marketingName || "iOS device",
    deviceUDID: deviceIdentity(device),
    coreDeviceID: device?.identifier || null,
    backend: device?.backend || "coredevice",
    osVersion: device?.deviceProperties?.osVersionNumber || null,
    transport: device?.connectionProperties?.transportType || null,
    tunnelIPAddress: device?.connectionProperties?.tunnelIPAddress || null,
  };
}

function preferDeviceRecord(existing, candidate) {
  const existingUsable = isUsablePhysicalDevice(existing);
  const candidateUsable = isUsablePhysicalDevice(candidate);
  if (existingUsable !== candidateUsable) {
    return existingUsable ? existing : candidate;
  }
  return existing?.backend === "coredevice" ? existing : candidate;
}

function deduplicateDevices(devices) {
  const byUDID = new Map();
  const withoutUDID = [];

  for (const device of devices) {
    const udid = deviceIdentity(device);
    if (!udid) {
      withoutUDID.push(device);
      continue;
    }

    const existing = byUDID.get(udid);
    byUDID.set(udid, existing ? preferDeviceRecord(existing, device) : device);
  }

  return [...byUDID.values(), ...withoutUDID];
}

export function parseDevicectlDevices(stdout) {
  const payload = JSON.parse(stdout);
  const devices = payload?.result?.devices;
  return Array.isArray(devices)
    ? devices.map((device) => ({ ...device, backend: device?.backend || "coredevice" }))
    : [];
}

export function parseLegacyDeviceUDIDs(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((udid) => udid.trim())
    .filter(Boolean);
}

export function createLegacyDevices(stdout) {
  return parseLegacyDeviceUDIDs(stdout).map((udid) => ({
    backend: "legacy",
    connectionProperties: {
      tunnelState: "connected",
      transportType: "wired",
    },
    deviceProperties: {
      name: "iOS device",
    },
    hardwareProperties: {
      reality: "physical",
      platform: "iOS",
      udid,
    },
  }));
}

export function listRuntimeTargets({ devices = [] } = {}) {
  const usablePhysicalDevices = preferWiredUsablePhysicalDevices(
    devices.filter(isUsablePhysicalDevice)
  );
  const targets = usablePhysicalDevices.map((device) => ({
    mode: "device",
    deviceUDID: deviceIdentity(device),
    backend: device?.backend || "coredevice",
    host: device?.connectionProperties?.tunnelIPAddress || null,
    selectionReason: isWiredPhysicalDevice(device)
      ? "usable_wired_physical_device"
      : "usable_physical_device",
    fallbackReason: null,
    physicalDeviceCount: usablePhysicalDevices.length,
    device: summarizeDevice(device),
  }));

  return {
    targets,
    physicalDeviceCount: usablePhysicalDevices.length,
  };
}

export function selectRuntimeTarget({ devices, requestedMode = "auto", requestedDeviceUDID = "" }) {
  const usablePhysicalDevices = devices.filter(isUsablePhysicalDevice);
  if (usablePhysicalDevices.length > 0) {
    const configured = usablePhysicalDevices.find((device) => {
      const identity = deviceIdentity(device);
      return identity === requestedDeviceUDID
        || device?.identifier === requestedDeviceUDID
        || device?.hardwareProperties?.udid === requestedDeviceUDID;
    });
    const preferredPhysicalDevices = preferWiredUsablePhysicalDevices(usablePhysicalDevices);
    const selected = configured || preferredPhysicalDevices[0];
    const selectedWired = isWiredPhysicalDevice(selected);
    const selectedLegacy = selected?.backend === "legacy";
    return {
      mode: "device",
      deviceUDID: deviceIdentity(selected),
      backend: selected?.backend || "coredevice",
      host: selected?.connectionProperties?.tunnelIPAddress || null,
      selectionReason: configured
        ? "configured_physical_device"
        : requestedDeviceUDID
          ? "configured_device_unavailable_selected_first_usable_physical_device"
          : selectedWired
            ? "first_wired_usable_physical_device"
            : selectedLegacy
              ? "first_legacy_physical_device"
              : "first_usable_physical_device",
      fallbackReason: null,
      physicalDeviceCount: usablePhysicalDevices.length,
      device: summarizeDevice(selected),
    };
  }

  return {
    mode: "none",
    deviceUDID: "",
    backend: null,
    host: null,
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

  async discoverDevices() {
    const devices = [];
    const errors = [];

    try {
      const { stdout } = await this.execFileImpl(
        "xcrun",
        ["devicectl", "list", "devices", "--json-output", "-"],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }
      );
      devices.push(...parseDevicectlDevices(stdout));
    } catch (error) {
      errors.push(`devicectl:${error?.message || "devicectl_failed"}`);
    }

    try {
      const { stdout } = await this.execFileImpl(
        "idevice_id",
        ["-l"],
        { maxBuffer: 1024 * 1024, timeout: 10000 }
      );
      devices.push(...createLegacyDevices(stdout));
    } catch (error) {
      errors.push(`idevice_id:${error?.message || "idevice_id_failed"}`);
    }

    return {
      devices: deduplicateDevices(devices),
      errors,
    };
  }

  async listAll(config = {}) {
    const { devices, errors } = await this.discoverDevices();
    const listed = listRuntimeTargets({ devices });
    return {
      success: true,
      payload: {
        ...listed,
        detectionErrors: errors,
      },
      error: null,
    };
  }

  async resolve(config) {
    const { devices, errors } = await this.discoverDevices();
    const target = selectRuntimeTarget({
      devices,
      requestedMode: "device",
      requestedDeviceUDID: config.deviceUDID,
    });
    if (target.mode === "device") {
      return {
        success: true,
        payload: target,
        error: null,
      };
    }

    if (errors.length === 2) {
      return {
        success: false,
        payload: null,
        error: `physical_device_detection_failed:${errors.join(";")}`,
      };
    }

    return {
      success: false,
      payload: target,
      error: "physical_device_required",
    };
  }
}

export function applyRuntimeTarget(config, target) {
  if (target?.mode === "device") {
    config.deviceUDID = target.deviceUDID || config.deviceUDID;
  }
  config.runtimeTarget = target;
  config.tunnelIPAddress = target?.device?.tunnelIPAddress || target?.host || null;
  return config;
}
