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
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:37777", fetchImpl });

  const result = await client.setText("field", "Hi");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:37777/debug/text/set");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "field", text: "Hi" });
});

test("typeText posts appended text to DebugBridge", async () => {
  const { calls, fetchImpl } = makeFetchRecorder({ success: true, id: "field", text: "Hi!" });
  const client = new HTTPBridgeClient({ baseURL: "http://127.0.0.1:37777", fetchImpl });

  const result = await client.typeText("field", "!");

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://127.0.0.1:37777/debug/text/type");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "field", text: "!" });
});
