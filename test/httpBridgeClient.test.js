import assert from "node:assert/strict";
import test from "node:test";

import { HTTPBridgeClient } from "../src/httpBridgeClient.js";

function makeFetchRecorder(responsePayload = { success: true }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responsePayload),
    };
  };
  return { calls, fetchImpl };
}

test("setText posts replacement text to DebugBridge", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({ success: true, id: "field", text: "Hi" });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:42671", fetchImpl });

  const result = await client.setText("field", "Hi");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:42671/debug/text/set");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "field", text: "Hi" });
});

test("typeText posts appended text to DebugBridge", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({ success: true, id: "field", text: "Hi!" });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:42671", fetchImpl });

  const result = await client.typeText("field", "!");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:42671/debug/text/type");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "field", text: "!" });
});

test("getRuntimeNode posts runtime anchor to DebugBridge", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({
    anchor: "figma.1739_13055",
    found: true,
    unique: true,
    matchCount: 1,
    node: { className: "UILabel" },
    matches: [],
    error: null,
  });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:42671", fetchImpl });

  const result = await client.getRuntimeNode("figma.1739_13055");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:42671/debug/runtime/node");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { anchor: "figma.1739_13055" });
});

test("getWindowTree reads the app UIWindow tree with query parameters", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({ success: true, windows: [] });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:42671", fetchImpl });

  await client.getWindowTree({ depth: 4, includeHidden: true, maxNodes: 100 });

  assert.equal(
    calls[0].url,
    "http://127.0.0.1:42671/debug/windows?depth=4&include_hidden=true&max_nodes=100"
  );
  assert.equal(calls[0].options.method, "GET");
});

test("readLogs searches the current app pool without a cursor", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({ success: true, status: "matched", lines: [] });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:42671", fetchImpl });

  await client.readLogs({ query: "upload", level: "error", category: "api", limit: 20 });

  assert.equal(
    calls[0].url,
    "http://127.0.0.1:42671/debug/logs?query=upload&level=error&category=api&limit=20"
  );
  assert.doesNotMatch(calls[0].url, /cursor|offset/);
});

test("bridge requests time out instead of hanging when the port accepts but does not respond", async () => {
  const client = new HTTPBridgeClient({
    baseURL: "http://127.0.0.1:42671",
    timeoutMs: 10,
    fetchImpl: (_url, options) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    }),
  });

  await assert.rejects(() => client.ping(), /bridge_request_timeout:10ms/);
});
