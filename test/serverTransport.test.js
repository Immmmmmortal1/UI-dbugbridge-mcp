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
  assert.equal(response.result.serverInfo.version, "0.1.13");
});

test("tools list includes text entry tools", async (t) => {
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
  await readJSONLine(server.stdout);

  server.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })}\n`);

  const response = await readJSONLine(server.stdout);
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.includes("set_text"), true);
  assert.equal(names.includes("type_text"), true);
});

test("tools list includes runtime node inspector", async (t) => {
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
  await readJSONLine(server.stdout);

  server.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })}\n`);

  const response = await readJSONLine(server.stdout);
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.includes("get_runtime_node"), true);
});

test("tools list exposes DebugBridge logs and removes Xcode/Lookin fallbacks", async (t) => {
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
  await readJSONLine(server.stdout);

  server.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })}\n`);

  const response = await readJSONLine(server.stdout);
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.includes("read_app_logs"), true);
  assert.equal(names.includes("wait_app_logs"), true);
  assert.equal(names.includes("inspect_ui"), true);
  assert.equal(names.includes("release_session"), true);
  assert.equal(names.includes("run_xcode_active_scheme"), false);
  assert.equal(names.includes("read_xcode_console"), false);
  assert.equal(names.includes("wait_xcode_console"), false);
});
