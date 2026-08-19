# UI-dbugbridge-mcp

`UI-dbugbridge-mcp` 是 Mac 侧的 MCP Server。它通过 stdio 接收 MCP 请求，再通过 `iproxy` 访问运行在 iOS App 内的 `LookDebugBridge` HTTP 服务。

本仓库只负责 MCP 编排，不负责编译、安装或启动 App。真机编译安装由 XcodeBuildMCP 的 `build_run_device` 完成。

## 两个仓库的职责

| 仓库 | 职责 |
| --- | --- |
| `UI-dbugbridge-mcp` | Mac 侧 MCP Server：真机预检、端口转发、UI 操作、UI 树读取、日志读取、运行态校验 |
| `LookDebugBridgeService` | iOS Debug Pod：在 App 进程内启动 HTTP Bridge，提供 UI、UI 树和临时内存日志能力 |

## 当前运行约束

- 只发现物理设备上的 DebugBridge，不扫描 iOS Simulator，也不回退到 localhost。
- `ensure_ports` / `ping` 会扫描真机目标的 `42671-42770`，并在结果里返回 `discovered` 列表。
- 通过 `bundleID` / `sessionID` / `deviceUDID` / `mode=device` 选择当前激活目标。
- 未指定选择器时，优先有线真机上的活桥，其次任意真机。
- App 编译安装由 XcodeBuildMCP 负责；本仓库不激活 Xcode scheme，不发送 `Command+R`。
- 不读取 Xcode Console，不调用 Lookin CLI。
- 真机优先走 CoreDevice tunnel；旧设备回退 `iproxy`。

## App 侧接入

### CocoaPods

正式接入使用独立 Pod 仓库：

```ruby
target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge',
      :git => 'git@github.com:Immmmmmortal1/LookDebugBridgeService.git',
      :tag => '0.1.7',
      :configurations => ['Debug']
end
```

不要再添加 `LookinServer`。执行：

```bash
pod install
```

### 启动 Bridge

在 App 启动阶段，仅 Debug 构建启动服务：

```swift
#if DEBUG
import LookDebugBridge

Task { @MainActor in
    LookDebugBridge.shared.startIfNeeded()
}
#endif
```

Bridge 启动后提供：

| HTTP 接口 | 用途 |
| --- | --- |
| `GET /ping` | 检查 Bridge 是否可用 |
| `GET /debug/page` | 读取当前语义页面和注册元素 |
| `GET /debug/windows` | 读取当前 UIWindow/UIView 树 |
| `POST /debug/runtime/node` | 按 accessibility anchor 读取运行态节点 |
| `POST /debug/tap` | 点击注册元素 |
| `POST /debug/switch` | 设置 UISwitch |
| `POST /debug/text/set` | 替换 UITextField/UITextView 文本 |
| `POST /debug/text/type` | 追加 UITextField/UITextView 文本 |
| `GET /debug/logs` | 查询或等待当前 App 进程的日志 |

### 日志接入

业务 Debug 日志必须进入 `LookDebugBridge.log`，或由 App 的 Debug 日志入口统一转发：

```swift
#if DEBUG
LovOnDebugLog.error("request failed", category: "api")
#endif
```

日志级别和分类是自由字符串，不限于固定枚举。`level` 和 `category` 查询为不区分大小写的精确匹配，`query` 为不区分大小写的消息子串匹配。

## 日志生命周期和查询规则

日志是 App 进程内的临时内存池：

- 不写本地文件；
- 不跨 App 进程保留；
- App 重启后创建新的日志池；
- 不使用 cursor、offset 或读取位置；
- `read_app_logs` 直接检索当前进程已经产生的完整日志池，默认返回最近 500 条，最多 5000 条；
- `wait_app_logs` 只等待本次请求开始后产生的、符合条件的新日志，最多等待 120 秒；
- `sessionID` 是 App 本次进程生成的调试会话标识，不是文件目录，也不是日志游标；
- `DEV_FLOW_SESSION_ID` 是 DevFlow/MCP 上下文标识，两者用途不同。

日志返回结构：

```json
{
  "success": true,
  "sessionID": "app-process-session-id",
  "status": "matched",
  "lines": [
    {
      "timestamp": "2026-07-31T06:00:00Z",
      "level": "error",
      "category": "api",
      "message": "request failed"
    }
  ],
  "error": null
}
```

`status` 的含义：

| status | 含义 |
| --- | --- |
| `matched` | 找到符合条件的日志 |
| `empty` | 当前池没有符合条件的日志（立即查询） |
| `timeout` | 等待超时，期间没有符合条件的新日志 |

查询示例：

```json
{
  "name": "read_app_logs",
  "arguments": {
    "query": "upload",
    "category": "oss",
    "limit": 50
  }
}
```

等待示例：

```json
{
  "name": "wait_app_logs",
  "arguments": {
    "query": "completed",
    "level": "info",
    "waitMs": 30000
  }
}
```

## Mac 侧安装与配置

要求：

- macOS；
- Node.js 18+；
- Xcode command line tools；
- `iproxy`；
- 已连接并信任的物理 iOS 设备。

Codex 配置示例：

```toml
[mcp_servers.ui_dbugbridge_mcp]
command = "/opt/homebrew/bin/node"
args = ["/absolute/path/UI-dbugbridge-mcp/src/server.js"]
startup_timeout_sec = 30.0

[mcp_servers.ui_dbugbridge_mcp.env]
# Optional: omit with BRIDGE_LOCAL_PORT for automatic per-process local ports.
# BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKDEBUG_DEVICE_UDID = "<physical-device-udid>"
IPROXY_PATH = "iproxy"
# Optional: omit to allocate a unique local port per MCP process.
# BRIDGE_LOCAL_PORT = "37777"
# BRIDGE_REMOTE_PORT 必须在 42671-42770 范围内，否则回退到默认扫描
# BRIDGE_REMOTE_PORT = "42671"
DEV_FLOW_SESSION_ID = "<devflow-session-id>"
```

### 隧道模式 vs iproxy 模式（端口说明）

`BRIDGE_BASE_URL` 和 `BRIDGE_LOCAL_PORT` 的默认值（`127.0.0.1:37777`）**仅 iproxy 模式**使用，不要据此探测本地端口：

| 模式 | 触发条件 | BRIDGE_BASE_URL / BRIDGE_LOCAL_PORT | 实际访问地址 |
| --- | --- | --- | --- |
| CoreDevice 隧道（iOS 17+ 默认） | 设备暴露 `tunnelIPAddress` | **忽略**，`ensureBridgeReachable` 会用 `tunnelIP` 覆盖 | `http://[<tunnelIP>]:<remotePort>` |
| iproxy（旧设备回退） | 无 tunnelIP，走 `iproxy` 转发 | 生效，本地 iproxy 监听 37777 | `http://127.0.0.1:37777` |

门禁类探针**不要**直接探测 `127.0.0.1:37777`：隧道模式下该端口无监听，会误报桥不可用。请通过 MCP 工具（`ping` / `ensure_ports`）走 preflight 流程判断桥可达性。

配置项：

| 配置项 | 必须 | 说明 |
| --- | --- | --- |
| `BRIDGE_BASE_URL` | 否 | 默认自动生成实际本机转发地址；host 仅允许回环（127.0.0.1/localhost/::1），非回环需显式开启 `LOOKDEBUG_ALLOW_ANY_URL` |
| `LOOKDEBUG_DEVICE_UDID` | 是 | 指定优先使用的物理设备 UDID |
| `IPROXY_PATH` | 否 | 默认 `iproxy` |
| `BRIDGE_LOCAL_PORT` | 否 | 默认自动分配本机端口；设置后固定使用指定端口（1-65535），若被其他转发占用则失败 |
| `BRIDGE_REMOTE_PORT` | 否 | 默认扫描 `42671-42770`；设置后固定使用指定端口，必须在 42671-42770 内，否则回退到默认 |
| `DEV_FLOW_SESSION_ID` | 否 | DevFlow 上下文标识，只用于运行上下文回传；未设置时回退 `CODEX_THREAD_ID`、`CURSOR_CONVERSATION_ID` |
| `LOOKDEBUG_SCREENSHOT_COMMAND` | 否 | 外部截图命令；使用 `{output}` 作为输出文件占位符（占位符替换后做 shell 转义，防止注入） |
| `LOOKDEBUG_ARTIFACT_ROOT` | 否 | artifact 根目录，设置后 `audit_runtime` 的输入/输出路径必须位于其内；未设置时写操作默认拒绝 |
| `LOOKDEBUG_ALLOW_ANY_PORT` | 否 | 危险开关，默认关闭。开启后允许 `BRIDGE_LOCAL_PORT`/`BRIDGE_REMOTE_PORT` 超出常规范围 |
| `LOOKDEBUG_ALLOW_ANY_URL` | 否 | 危险开关，默认关闭。开启后允许 `BRIDGE_BASE_URL` 指向非回环主机 |

截图不是 UI 树或日志的依赖能力。未配置 `LOOKDEBUG_SCREENSHOT_COMMAND` 时，`get_screenshot` 返回 `screenshot_command_not_configured`。配置后执行返回结果会带 `warning: screenshot_command_executed_as_configured` 提示。

## 标准真机调试流程

```text
1. session_show_defaults
2. 未指定设备时，默认选中有线连接的第一台可用物理设备，再 build_run_device
3. 启动并确认 App 内 LookDebugBridge
4. MCP tools/call: ping 或任意业务工具（自动执行预检）
5. get_debug_page / inspect_ui
6. tap_element / set_switch / set_text / type_text / run_flow
7. read_app_logs 或 wait_app_logs 验证业务结果
8. get_runtime_node / audit_runtime 做运行态校验
```

`build_run_device`、`session_show_defaults` 属于 XcodeBuildMCP，不是本仓库提供的 MCP 工具。本仓库不主动切换 Xcode scheme，也不模拟 `Command+R`。设备选择遵循上方「有线第一台」规则；`LOOKDEBUG_DEVICE_UDID` 仅用于显式覆盖。

## MCP 工具契约

所有业务工具都通过 stdio 的 MCP `tools/list` 和 `tools/call` 暴露。工具结果统一包含：

```json
{
  "source": "debug_bridge",
  "success": true,
  "payload": {},
  "error": null
}
```

### 环境与连接

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `ping` | `bundleID?`, `sessionID?`, `deviceUDID?`, `mode?`, `remotePort?` | 扫描全部目标上的活桥并激活一个 |
| `release_session` | `exitAfterRelease?`, `reason?` | 释放本 MCP 实例的 iproxy；默认随后退出 server 进程 |
| `ensure_ports` | 同上 | 同上；结果包含 `discovered` 多目标列表 |

### UI 页面和节点

| 工具 | 主要参数 | 说明 |
| --- | --- | --- |
| `get_debug_page` | `expectedPageID?`, `saveArtifact?`, `timeoutMs?`, `intervalMs?` | 读取当前语义页面、页面标题和注册元素 |
| `inspect_ui` | `depth?`, `includeHidden?`, `maxNodes?` | 读取当前 UIWindow/UIView 节点树 |
| `get_runtime_node` | `anchor` | 按 `UIView.accessibilityIdentifier` 查找运行态节点；要求结果唯一 |
| `get_page` | 同 `get_debug_page` | 兼容别名，已弃用 |
| `get_ui_hierarchy` | 无 | `inspect_ui` 兼容别名，已弃用 |

`inspect_ui` 示例：

```json
{
  "name": "inspect_ui",
  "arguments": {
    "depth": 8,
    "includeHidden": false,
    "maxNodes": 2000
  }
}
```

### UI 操作

| 工具 | 必填参数 | 说明 |
| --- | --- | --- |
| `tap_element` | `id` | 点击注册元素 |
| `set_switch` | `id`, `isOn` | 设置开关状态 |
| `set_text` | `id`, `text` | 替换输入控件文本 |
| `type_text` | `id`, `text` | 追加输入控件文本 |
| `run_flow` | `steps` | 按顺序执行多步 UI 流程 |

操作工具使用 DebugBridge 注册的稳定 `id`，不使用坐标。单步可附加 `waitForPageID`、`waitForElement`、`timeoutMs`、`intervalMs` 等等待条件。

`run_flow.steps` 支持：

```text
tap
tap_if_present
set_switch
set_text
type_text
wait_for_page
wait_for_element
sleep
```

流程示例：

```json
{
  "name": "run_flow",
  "arguments": {
    "steps": [
      {"action": "set_text", "id": "login.email", "text": "user@example.com"},
      {"action": "tap", "id": "login.submit", "waitForPageID": "home"},
      {"action": "wait_for_element", "id": "home.content"}
    ]
  }
}
```

### 日志、截图和运行态审查

| 工具 | 必填参数 | 说明 |
| --- | --- | --- |
| `read_app_logs` | 无 | 查询当前 App 进程日志池 |
| `wait_app_logs` | 无 | 等待当前请求开始后的新匹配日志 |
| `get_screenshot` | 无 | 调用配置的外部截图命令 |
| `audit_runtime` | `figmaRawPath` | 将 Figma raw JSON 与当前 DebugBridge 页面做语义校对并生成报告 |

`audit_runtime` 可选 `figmaNodeID`、`expectedPageID`、`labelAliases`、`artifactDir`、`outJsonPath`、`outMarkdownPath`、`timeoutMs`、`intervalMs`。

页面、流程和审查工具的 artifact 默认写入 `.devflow-ui/runtime`；截图默认写入当前工作目录下的 `.tmp/lookdebug-mcp`。日志不写入这些目录。

## 常见错误

| 错误 | 处理 |
| --- | --- |
| `physical_device_required` | 连接物理设备，开启开发者模式并确认 Developer Disk Image 服务可用 |
| `physical_device_detection_failed:*` | 检查 `xcrun devicectl list devices --json-output -` 和 Xcode command line tools |
| `missing_LOOKDEBUG_DEVICE_UDID` | 设置 `LOOKDEBUG_DEVICE_UDID` |
| `iproxy_not_reachable` | 检查 `iproxy` 路径、设备 UDID 和端口占用 |
| `debug_bridge_ping_failed` | 确认 App 已启动 DebugBridge 且 `BRIDGE_BASE_URL` 正确 |
| `release_session` | dev-flow commit 完成后调用，释放本 MCP 实例的 iproxy 并退出进程 |
| `page_unavailable` | 当前页面没有可用的页面描述或 App 仍在切换页面 |
| `element_not_found` | 重新调用 `get_debug_page`，使用当前页面中的稳定元素 ID |
| `unsupported_element_type` | 当前元素不支持请求的操作 |
| `read_app_logs` 返回 `empty` | 确认日志入口确实调用了 `LookDebugBridge.log`，并放宽 query、level、category 条件 |

## 本地开发和验证

```bash
npm run build
npm test
```

运行 MCP Server：

```bash
node src/server.js
```

该进程使用 newline-delimited JSON 的 stdio MCP transport，支持 `initialize`、`notifications/initialized`、`tools/list` 和 `tools/call`。

## 发布与群通知

打 tag 发布新版本并 push 时，`.githooks/pre-push` 会自动推送飞书群机器人通知（仅发版触发，普通提交不通知）。

新 clone 后启用 hook（一次性）：

```bash
git config core.hooksPath .githooks
```

发布流程：

```bash
# 1. bump 版本（package.json 的 version）
# 2. commit 改动
# 3. git tag -a <版本> -m "Release <版本>"
# 4. git push origin main && git push origin <版本>   # 触发飞书通知
```

默认 webhook 地址内置于 `.githooks/pre-push`，可用环境变量 `LOOKDEBUG_LARK_WEBHOOK` 覆盖。
