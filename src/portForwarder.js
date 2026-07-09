import net from "node:net";
import { spawn } from "node:child_process";

function canConnect(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export class PortForwarder {
  constructor(config) {
    this.config = config;
    this.children = new Map();

    process.once("exit", () => {
      this.stopAll();
    });
  }

  async ensureAll() {
    if (this.config.lookinMode !== "device") {
      return {
        success: true,
        payload: {
          mode: this.config.lookinMode,
          skipped: true,
          reason: "port_forwarding_only_needed_for_device_mode",
        },
      };
    }

    if (!this.config.deviceUDID) {
      return {
        success: false,
        error: "missing_LOOKDEBUG_DEVICE_UDID",
      };
    }

    const results = [];
    for (const forward of this.config.portForwards) {
      results.push(await this.ensure(forward));
    }

    const failed = results.find((result) => !result.success);
    return {
      success: !failed,
      payload: {
        deviceUDID: this.config.deviceUDID,
        forwards: results,
      },
      error: failed?.error ?? null,
    };
  }

  async ensure(forward) {
    if (await canConnect(forward.localPort)) {
      return {
        success: true,
        name: forward.name,
        localPort: forward.localPort,
        remotePort: forward.remotePort,
        status: "already_open",
      };
    }

    if (!this.children.has(forward.name)) {
      const child = spawn(
        this.config.iproxyPath,
        ["-u", this.config.deviceUDID, `${forward.localPort}:${forward.remotePort}`],
        {
          cwd: this.config.cwd,
          stdio: ["ignore", "ignore", "pipe"],
        }
      );

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("exit", () => {
        this.children.delete(forward.name);
      });
      child.once("error", () => {
        this.children.delete(forward.name);
      });

      this.children.set(forward.name, { child, stderr: () => stderr });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await canConnect(forward.localPort)) {
      return {
        success: true,
        name: forward.name,
        localPort: forward.localPort,
        remotePort: forward.remotePort,
        status: "started",
      };
    }

    const childInfo = this.children.get(forward.name);
    return {
      success: false,
      name: forward.name,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      status: "failed",
      error: childInfo?.stderr().trim() || "iproxy_not_reachable",
    };
  }

  stopAll() {
    for (const { child } of this.children.values()) {
      child.kill();
    }
    this.children.clear();
  }
}
