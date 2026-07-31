# ui_lookin_debugbridge

LoveOn 的 Mac 侧 MCP Server，配合 iOS App 内的 `LookDebugBridge`，提供三类能力：

1. 通过稳定 ID 操作 UI；
2. 读取 App 当前 `UIWindow`/`UIView` 节点树并验证运行态 UI；
3. 读取当前 App 运行实例的临时内存日志池。

日志不写文件、不跨运行保留、不使用 cursor/offset。每次 App 进程重新启动都会创建新的日志池，MCP 直接按 query、level、category 检索完整当前池；`wait_app_logs` 只在当前请求内等待新匹配日志。

## 固定运行规则

- LoveOn 调试只使用物理设备。
- App 通过 XcodeBuildMCP `build_run_device` 编译、安装并启动。
- 不激活 Xcode scheme，不发送 `Command+R`，不使用 Xcode Console 或 Lookin CLI。
- 设备端只启动 DebugBridge HTTP 服务；Mac 侧通过 `iproxy` 转发 `37777:37777`。
- `DEV_FLOW_SESSION_ID` 只作为当前调试上下文标识返回，不作为日志文件路径或读取游标。

## App 侧接入

```ruby
target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge',
      :path => '../UI-lookin-dbugbridge',
      :configurations => ['Debug']
end
```

也可以使用远程 Pod 源；关键是不要再添加 `LookinServer`。执行：

```bash
pod install
```

在 App 启动时启动 Bridge：

```swift
#if DEBUG
import LookDebugBridge

Task { @MainActor in
    LookDebugBridge.shared.startIfNeeded()
}
#endif
```

日志统一从 App 的 Debug 日志入口转发：

```swift
#if DEBUG
LovOnDebugLog.error("request failed", category: "api")
#endif
```

Bridge 监听 `37777`。`LookDebugBridge.log(_:level:category:)` 会把日志放入进程内 actor 日志池；App 进程结束后日志自然消失。

## Mac 侧安装与配置

要求：Node.js 18+、`iproxy`。本项目无第三方 npm 运行时依赖：

```bash
npm run build
npm test
```

Codex MCP 配置示例：

```toml
[mcp_servers.ui_lookin_debugbridge]
command = "/absolute/path/to/node"
args = ["/absolute/path/ui_lookin_debugbridge/src/server.js"]
startup_timeout_sec = 30.0

[mcp_servers.ui_lookin_debugbridge.env]
BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKDEBUG_DEVICE_UDID = "<physical-device-udid>"
IPROXY_PATH = "iproxy"
BRIDGE_LOCAL_PORT = "37777"
BRIDGE_REMOTE_PORT = "37777"
```

截图不是 UI 树或日志依赖；如需截图可额外配置：

```toml
LOOKDEBUG_SCREENSHOT_COMMAND = "<command using {output}>"
```

MCP 会强制探测已连接、开发服务可用的物理设备；没有物理设备时返回 `physical_device_required`，不会静默切到模拟器。

## 推荐调试流程

1. 调用 XcodeBuildMCP `session_show_defaults` 检查 workspace、scheme 和设备默认值。
2. 调用 `build_run_device`，并传入当前 `DEV_FLOW_SESSION_ID`。
3. MCP 调用 `ensure_ports`，建立或复用 `iproxy` 转发。
4. 调用 `ping` 检查 App 内 DebugBridge。
5. 使用 `get_debug_page`、`tap_element`、`set_text`、`run_flow` 操作 UI。
6. 使用 `inspect_ui` 读取 UIWindow/UIView 树，或使用 `get_runtime_node` 验证指定 accessibility anchor。
7. 使用 `read_app_logs` 检索当前运行的完整内存日志池；需要等待时使用 `wait_app_logs`。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ping` | 检查物理设备转发与 App 内 DebugBridge |
| `ensure_ports` | 启动或复用 `iproxy` 的 `37777:37777` 转发 |
| `get_debug_page` / `get_page` | 读取页面 ID、标题和注册元素 |
| `inspect_ui` / `get_ui_hierarchy` | 读取当前 UIWindow/UIView 树 |
| `get_runtime_node` | 按 accessibility identifier 查找运行态 UIView |
| `tap_element` | 按稳定 ID 点击 |
| `set_switch` | 设置开关 |
| `set_text` / `type_text` | 替换或追加文本 |
| `run_flow` | 执行多步 UI 流程 |
| `read_app_logs` | 从当前运行的完整内存池检索日志 |
| `wait_app_logs` | 等待新的匹配日志，不需要 cursor |
| `audit_runtime` | 将 Figma raw 数据与 DebugBridge 页面做语义校对 |
| `get_screenshot` | 执行可选的外部截图命令 |

日志查询示例：

```json
{"name":"read_app_logs","arguments":{"query":"upload","category":"oss","limit":50}}
```

```json
{"name":"wait_app_logs","arguments":{"query":"completed","level":"info","waitMs":30000}}
```

返回中的 `sessionID` 是当前调试会话标识，`status` 为 `matched`、`empty` 或 `timeout`。返回内容没有 cursor、offset 或本地日志路径。

窗口树查询示例：

```json
{"name":"inspect_ui","arguments":{"depth":8,"includeHidden":false,"maxNodes":2000}}
```

## 故障排查

### `physical_device_required`

确认设备已配对、开发者模式已开启、Developer Disk Image 服务可用，并检查：

```bash
xcrun devicectl list devices
```

### `debug_bridge_ping_failed`

- 确认 App 是 Debug 构建并启动了 `LookDebugBridge.shared.startIfNeeded()`；
- 确认 `iproxy -u <udid> 37777:37777` 可用；
- 确认 `BRIDGE_BASE_URL` 为 `http://127.0.0.1:37777`。

### `read_app_logs` 返回 `empty`

这是当前 App 运行实例的内存池查询。确认 App 已启动、日志入口确实调用了 `LookDebugBridge.log`，并检查 query、level、category 是否过窄。重启 App 后旧日志不会恢复，这是设计行为。

## 本地验证

```bash
npm run build
npm test
```

真机运行由 XcodeBuildMCP 完成：

```text
session_show_defaults → build_run_device → ensure_ports → ping
```

本 MCP Server 使用 stdio，支持 `initialize`、`tools/list` 和 `tools/call`。
