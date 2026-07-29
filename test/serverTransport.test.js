import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function readJSONLine(stream, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed_out_waiting_for_json_line"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      stream.off("data", onData);
    }

    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    }

    stream.on("data", onData);
  });
}

test("stdio transport accepts and returns newline-delimited MCP messages", async (t) => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());

  server.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "transport-test", version: "1.0.0" },
    },
  })}\n`);

  const response = await readJSONLine(server.stdout);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "lookdebug-mcp");
});
