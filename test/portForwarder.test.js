import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import { PortForwarder } from "../src/portForwarder.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function makeConfig({ deviceUDID = "device-1", localPort = 0, autoAllocate = true } = {}) {
  return {
    deviceUDID,
    iproxyPath: "iproxy",
    cwd: process.cwd(),
    bridgeBaseURL: "http://127.0.0.1:37777",
    bridgeBaseURLPortAuto: true,
    portForwards: [{
      name: "debug_bridge",
      localPort,
      autoAllocate,
      remotePort: 37777,
    }],
  };
}

function makeSpawnRecorder() {
  const calls = [];
  const children = [];
  return {
    calls,
    children,
    spawnImpl: (command, args) => {
      const child = new FakeChild();
      calls.push({ command, args });
      children.push(child);
      return child;
    },
  };
}

test("auto allocation gives separate local ports to separate device sessions", async () => {
  const firstSpawn = makeSpawnRecorder();
  const firstConfig = makeConfig({ deviceUDID: "device-1" });
  const first = new PortForwarder(firstConfig, {
    ...firstSpawn,
    findFreePortImpl: async () => 41001,
    connectImpl: async () => true,
    onPortAssigned: ({ localPort }) => {
      firstConfig.bridgeBaseURL = `http://127.0.0.1:${localPort}`;
    },
  });
  const secondSpawn = makeSpawnRecorder();
  const secondConfig = makeConfig({ deviceUDID: "device-2" });
  const second = new PortForwarder(secondConfig, {
    ...secondSpawn,
    findFreePortImpl: async () => 41002,
    connectImpl: async () => true,
  });

  const [firstResult, secondResult] = await Promise.all([
    first.ensureAll(),
    second.ensureAll(),
  ]);

  assert.equal(firstResult.success, true);
  assert.equal(secondResult.success, true);
  assert.notEqual(firstResult.payload.forwards[0].localPort, secondResult.payload.forwards[0].localPort);
  assert.deepEqual(firstSpawn.calls[0].args, ["-u", "device-1", "41001:37777"]);
  assert.deepEqual(secondSpawn.calls[0].args, ["-u", "device-2", "41002:37777"]);
  assert.equal(firstConfig.bridgeBaseURL, "http://127.0.0.1:41001");
});

test("a loopback base URL without an explicit local port is rewritten to the allocated port", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  config.bridgeBaseURL = "http://localhost:37777";
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => 41005,
    connectImpl: async () => true,
  });

  await forwarder.ensureAll();

  assert.equal(config.bridgeBaseURL, "http://localhost:41005");
});

test("an open explicit port without an owned child is rejected", async () => {
  const recorder = makeSpawnRecorder();
  const forwarder = new PortForwarder(makeConfig({ localPort: 37777, autoAllocate: false }), {
    ...recorder,
    connectImpl: async () => true,
  });

  const result = await forwarder.ensureAll();

  assert.equal(result.success, false);
  assert.equal(result.error, "local_port_in_use");
  assert.equal(recorder.calls.length, 0);
});

test("a stale owned forwarding is rebuilt on a new auto-assigned port", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  let nextPort = 41003;
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => nextPort++,
    connectImpl: async () => true,
  });

  const firstResult = await forwarder.ensureAll();
  recorder.children[0].exitCode = 1;
  const secondResult = await forwarder.ensureAll();

  assert.equal(firstResult.payload.forwards[0].localPort, 41003);
  assert.equal(secondResult.success, true);
  assert.equal(secondResult.payload.forwards[0].localPort, 41004);
  assert.equal(recorder.calls.length, 2);
});

test("concurrent checks for one forward share one iproxy child", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => 41008,
    connectImpl: async () => true,
  });

  const [first, second] = await Promise.all([
    forwarder.ensureAll(),
    forwarder.ensureAll(),
  ]);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(recorder.calls.length, 1);
  assert.equal(first.payload.forwards[0].localPort, 41008);
  assert.equal(second.payload.forwards[0].localPort, 41008);
});

test("an existing forwarding is not reused after ownership verification fails", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  let nextPort = 41013;
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => nextPort++,
    connectImpl: async () => true,
  });

  const firstResult = await forwarder.ensureAll();
  let ownershipChecks = 0;
  forwarder.verifyPortOwnerImpl = async () => ownershipChecks++ > 0;
  const secondResult = await forwarder.ensureAll();

  assert.equal(firstResult.payload.forwards[0].localPort, 41013);
  assert.equal(secondResult.success, true);
  assert.equal(secondResult.payload.forwards[0].localPort, 41014);
  assert.equal(recorder.calls.length, 2);
});

test("auto allocation retries when iproxy exits before binding", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  let nextPort = 41009;
  let spawnCount = 0;
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => nextPort++,
    connectImpl: async () => true,
    spawnImpl: (command, args, options) => {
      const child = recorder.spawnImpl(command, args, options);
      spawnCount += 1;
      if (spawnCount === 1) {
        child.exitCode = 1;
        child.stderr.emit("data", "Address already in use");
      }
      return child;
    },
  });

  const result = await forwarder.ensureAll();

  assert.equal(result.success, true);
  assert.equal(result.payload.forwards[0].localPort, 41010);
  assert.equal(recorder.calls.length, 2);
});

test("auto allocation rejects a reachable port owned by another process", async () => {
  const recorder = makeSpawnRecorder();
  const config = makeConfig();
  let nextPort = 41011;
  const forwarder = new PortForwarder(config, {
    ...recorder,
    findFreePortImpl: async () => nextPort++,
    connectImpl: async () => true,
  });
  forwarder.verifyPortOwnerImpl = async () => false;

  const result = await forwarder.ensureAll();

  assert.equal(result.success, false);
  assert.equal(result.error, "iproxy_not_owned");
  assert.equal(recorder.calls.length, 8);
});
