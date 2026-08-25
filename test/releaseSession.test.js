import assert from "node:assert/strict";
import test from "node:test";
import { PortForwarder } from "../src/portForwarder.js";

test("stopAllAndWait clears active forwards", async () => {
  const killed = [];
  const config = {
    deviceUDID: "TEST-UDID",
    iproxyPath: "iproxy",
    cwd: process.cwd(),
    bridgeBaseURLPortAuto: true,
    bridgeBaseURL: "http://127.0.0.1:37777",
    portForwards: [{ name: "debug_bridge", localPort: 0, autoAllocate: true, remotePort: 37777 }],
  };

  const forwarder = new PortForwarder(config, {
    spawnImpl: () => ({
      pid: 4242,
      exitCode: null,
      signalCode: null,
      stderr: { on() {} },
      once(event, handler) {
        if (event === "exit") {
          this._exitHandler = handler;
        }
      },
      kill() {
        killed.push(4242);
        this.exitCode = 0;
        this._exitHandler?.(0);
      },
    }),
    findFreePortImpl: async () => 51001,
    connectImpl: async () => true,
    execFileImpl: (_cmd, _args, _opts, cb) => cb(null, "p4242\n", ""),
  });

  const ensured = await forwarder.ensure(config.portForwards[0]);
  assert.equal(ensured.success, true);
  assert.equal(forwarder.activeForwards().length, 1);

  await forwarder.stopAllAndWait();
  assert.deepEqual(killed, [4242]);
  assert.equal(forwarder.activeForwards().length, 0);
});
