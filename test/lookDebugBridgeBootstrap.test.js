import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../Sources/LookDebugBridge/LookDebugBridge.swift", import.meta.url);

test("LookDebugBridge starts only its in-app bridge and exposes session-scoped logging", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.doesNotMatch(source, /LookinServer/);
  assert.doesNotMatch(source, /startLookinIfAvailable/);
  // sessionID 是上下文标记（运行时可经 POST /debug/session 注入），不是并发隔离
  // canonical 实现为可变存储盒（LookDebugSessionBox），用 static var 暴露只读视图
  assert.match(source, /static var sessionID/);
  assert.match(source, /CURSOR_CONVERSATION_ID/);
  assert.match(source, /LookDebugLogStore\.shared\.append/);
  // setSessionID 运行时注入：Mac 侧 preflight 在确认桥后注入真实会话 id
  assert.match(source, /setSessionID/);
});

test("LookDebugBridge no longer ships a LookDebugPort.swift-style default-port helper", async () => {
  // canonical 已移除 LookDebugPort：默认端口 37777 由 init(port: UInt16 = 37777) 内联
  // 避免两份不同默认端口（LookDebugPort.resolve 与 init 默认值）漂移
  const source = await readFile(sourceURL, "utf8");
  assert.doesNotMatch(source, /LookDebugPort\.resolve/);
  assert.match(source, /init\(port: UInt16 = 37777\)/);
});
