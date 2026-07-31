# UI-dbugbridge-mcp

`UI-dbugbridge-mcp` 是 Mac 侧的 MCP Server。它通过 stdio 接收 MCP 请求，再通过 `iproxy` 访问运行在 iOS App 内的 `LookDebugBridge` HTTP 服务。

本仓库只负责 MCP 编排，不负责编译、安装或启动 App。真机编译安装由 XcodeBuildMCP 的 `build_run_device` 完成。

## 两个仓库的职责

| 仓库 | 职责 |
| --- | --- |
| `UI-dbugbridge-mcp` | Mac 侧 MCP Server：真机预检、端口转发、UI 操作、UI 树读取、日志读取、运行态校验 |
| `LookDebugBridgeService` | iOS Debug Pod：在 App 进程内启动 HTTP Bridge，提供 UI、UI 树和临时内存日志能力 |

## 当前运行约束

- 只允许物理 iOS 设备。
- App 必须由 `build_run_device` 编译、安装并启动。
- 不激活 Xcode scheme，不发送 `Command+R`。
- 不读取 Xcode Console，不调用 Lookin CLI。
- App 端 Bridge 默认监听 `37777`；Mac 端通过 `iproxy` 转发到 `127.0.0.1:37777`。
- MCP 每次调用业务工具前都会执行物理设备和 DebugBridge 预检；`ensure_ports`、`ping` 仍可用于显式诊断。

没有连接、开发者模式未开启或 Developer Disk Image 服务不可用的物理设备时，返回 `physical_device_required`，不会静默切换到模拟器。

## App 侧接入

### CocoaPods

正式接入使用独立 Pod 仓库：

```ruby
target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge',
      :git => 'git@github.com:Immmmmmortal1/LookDebugBridgeService.git',
      :tag => '0.1.5',
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
BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKDEBUG_DEVICE_UDID = "<physical-device-udid>"
IPROXY_PATH = "iproxy"
BRIDGE_LOCAL_PORT = "37777"
BRIDGE_REMOTE_PORT = "37777"
DEV_FLOW_SESSION_ID = "<devflow-session-id>"
```

配置项：

| 配置项 | 必须 | 说明 |
| --- | --- | --- |
| `BRIDGE_BASE_URL` | 否 | 默认 `http://127.0.0.1:37777` |
| `LOOKDEBUG_DEVICE_UDID` | 是 | 指定优先使用的物理设备 UDID |
| `IPROXY_PATH` | 否 | 默认 `iproxy` |
| `BRIDGE_LOCAL_PORT` | 否 | 默认 `37777` |
| `BRIDGE_REMOTE_PORT` | 否 | 默认 `37777` |
| `DEV_FLOW_SESSION_ID` | 否 | DevFlow 上下文标识，只用于运行上下文回传 |
| `LOOKDEBUG_SCREENSHOT_COMMAND` | 否 | 外部截图命令；使用 `{output}` 作为输出文件占位符 |

截图不是 UI 树或日志的依赖能力。未配置 `LOOKDEBUG_SCREENSHOT_COMMAND` 时，`get_screenshot` 返回 `screenshot_command_not_configured`。

## 标准真机调试流程

```text
1. session_show_defaults
2. build_run_device
3. 启动并确认 App 内 LookDebugBridge
4. MCP tools/call: ping 或任意业务工具（自动执行预检）
5. get_debug_page / inspect_ui
6. tap_element / set_switch / set_text / type_text / run_flow
7. read_app_logs 或 wait_app_logs 验证业务结果
8. get_runtime_node / audit_runtime 做运行态校验
```

`build_run_device`、`session_show_defaults` 属于 XcodeBuildMCP，不是本仓库提供的 MCP 工具。本仓库不主动切换 Xcode scheme，也不模拟 `Command+R`。

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
| `ping` | 无 | 物理设备预检并检查 App Bridge |
| `ensure_ports` | 无 | 创建或复用 `iproxy` 转发 |

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
