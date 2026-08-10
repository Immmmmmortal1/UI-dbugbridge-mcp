import net from "node:net";
import { execFile as defaultExecFile, spawn as defaultSpawn } from "node:child_process";

const AUTO_PORT_ATTEMPTS = 8;
const STARTUP_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 50;

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

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("free_port_not_allocated"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function withPort(baseURL, localPort) {
  const url = new URL(baseURL);
  url.port = String(localPort);
  return url.toString().replace(/\/$/, "");
}

function verifyPortOwner(child, localPort, execFileImpl = defaultExecFile) {
  if (!Number.isInteger(child?.pid)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    execFileImpl(
      "lsof",
      ["-nP", "-a", "-p", String(child.pid), `-iTCP:${localPort}`, "-sTCP:LISTEN", "-Fp"],
      { timeout: 1000 },
      (error, stdout = "") => {
        resolve(!error && stdout.split(/\r?\n/).includes(`p${child.pid}`));
      }
    );
  });
}

export class PortForwarder {
  constructor(config, {
    spawnImpl = defaultSpawn,
    findFreePortImpl = findFreePort,
    connectImpl = canConnect,
    execFileImpl = defaultExecFile,
    onPortAssigned = () => {},
  } = {}) {
    this.config = config;
    this.children = new Map();
    this.pending = new Map();
    this.spawnImpl = spawnImpl;
    this.findFreePortImpl = findFreePortImpl;
    this.connectImpl = connectImpl;
    this.verifyPortOwnerImpl = (child, localPort) => verifyPortOwner(child, localPort, execFileImpl);
    this.onPortAssigned = onPortAssigned;

    process.once("exit", () => {
      this.stopAll();
    });
  }

  async ensureAll() {
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
    const pending = this.pending.get(forward.name);
    if (pending) {
      return pending;
    }

    const operation = this.ensureOnce(forward);
    this.pending.set(forward.name, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(forward.name) === operation) {
        this.pending.delete(forward.name);
      }
    }
  }

  async ensureOnce(forward) {
    const existing = this.children.get(forward.name);
    if (existing && isRunning(existing.child) && await this.connectImpl(forward.localPort)) {
      if (await this.verifyPortOwnerImpl(existing.child, forward.localPort)) {
        return this.successResult(forward, "already_open");
      }
    }

    if (existing) {
      await this.stopAndWait(forward.name);
    }

    const configuredPort = forward.autoAllocate ? 0 : forward.localPort;
    if (configuredPort > 0 && await this.connectImpl(configuredPort)) {
      return this.failureResult(forward, "local_port_in_use");
    }

    const attempts = configuredPort > 0 ? 1 : AUTO_PORT_ATTEMPTS;
    let lastError = "iproxy_not_reachable";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const localPort = configuredPort > 0 ? configuredPort : await this.findFreePortImpl();
      const result = await this.start(forward, localPort);
      if (result.success) {
        forward.localPort = localPort;
        if (this.config.bridgeBaseURLPortAuto) {
          this.config.bridgeBaseURL = withPort(this.config.bridgeBaseURL, localPort);
        }
        this.onPortAssigned({ ...forward, localPort });
        return result;
      }

      lastError = result.error;
      if (configuredPort > 0) {
        return { ...result, localPort: configuredPort };
      }
    }

    return this.failureResult(forward, lastError);
  }

  async start(forward, localPort) {
    const child = this.spawnImpl(
      this.config.iproxyPath,
      ["-u", this.config.deviceUDID, `${localPort}:${forward.remotePort}`],
      {
        cwd: this.config.cwd,
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", () => {
      const current = this.children.get(forward.name);
      if (current?.child === child) {
        this.children.delete(forward.name);
      }
    });
    child.once("error", () => {
      const current = this.children.get(forward.name);
      if (current?.child === child) {
        this.children.delete(forward.name);
      }
    });

    this.children.set(forward.name, { child, stderr: () => stderr });
    const reachable = await this.waitUntilReachable(child, localPort);
    if (reachable === "ready") {
      return this.successResult({ ...forward, localPort }, "started");
    }

    await this.stopAndWait(forward.name);
    return this.failureResult(
      { ...forward, localPort },
      reachable === "wrong_owner"
        ? "iproxy_not_owned"
        : stderr.trim() || "iproxy_not_reachable"
    );
  }

  async waitUntilReachable(child, localPort) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isRunning(child)) {
        return false;
      }
      if (await this.connectImpl(localPort)) {
        if (!isRunning(child)) {
          return "not_reachable";
        }
        return await this.verifyPortOwnerImpl(child, localPort) ? "ready" : "wrong_owner";
      }
      await delay(POLL_INTERVAL_MS);
    }
    return "not_reachable";
  }

  successResult(forward, status) {
    return {
      success: true,
      name: forward.name,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      status,
    };
  }

  failureResult(forward, error) {
    return {
      success: false,
      name: forward.name,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      status: "failed",
      error,
    };
  }

  stop(name) {
    const entry = this.children.get(name);
    if (!entry) {
      return;
    }
    entry.child.kill();
    this.children.delete(name);
  }

  async stopAndWait(name) {
    const entry = this.children.get(name);
    if (!entry) {
      return;
    }

    const child = entry.child;
    const exited = isRunning(child)
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve();
    this.stop(name);
    await Promise.race([exited, delay(500)]);
  }

  stopAll() {
    for (const name of this.children.keys()) {
      this.stop(name);
    }
  }
}
