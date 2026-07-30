# ui_lookin_debugbridge

面向 AI 和自动化脚本的 iOS Debug 调试桥。它把 UI 层级读取、页面语义、稳定 ID 操作、Xcode Console 和截图能力统一为一个 MCP Server。

> 本仓库是 **Mac 侧 MCP Server**，不是 Codex Skill。iOS App 还需要接入 [`LookDebugBridge`](https://github.com/Immmmmmortal1/LookDebugBridge)。两端都配置完成后才能使用完整能力。

## 先选运行模式

| 场景 | `LOOKIN_MODE` | 是否需要 `iproxy` | 必填设备信息 |
| --- | --- | --- | --- |
| iOS 模拟器 | `simulator` | 否 | 无 |
| iPhone / iPad 真机 | `device` | 是 | `LOOKDEBUG_DEVICE_UDID` |

## 5 分钟快速接入

下面以 Codex 为例。完整参数和故障排查见后续章节。

### 1. App 接入 Debug Pod

```ruby
target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge',
      :git => 'git@github.com:Immmmmmortal1/LookDebugBridge.git',
      :configurations => ['Debug']
end
```

```bash
pod install
```

在 App 启动时调用：

```swift
#if DEBUG
import LookDebugBridge

Task { @MainActor in
    LookDebugBridge.shared.startIfNeeded()
}
#endif
```

### 2. Mac 安装 MCP Server

```bash
git clone git@github.com:Immmmmmortal1/ui_lookin_debugbridge.git
cd ui_lookin_debugbridge
npm run build
npm test
```

同时确保 [`lookin-cli`](https://github.com/lyleLH/lookin-cli) 可执行；真机模式还需确保 `iproxy` 可执行。

### 3. Codex 注册 MCP

将以下配置添加到 `~/.codex/config.toml`，并替换两个绝对路径：

```toml
[mcp_servers.ui_lookin_debugbridge]
command = "/absolute/path/to/node"
args = ["/absolute/path/ui_lookin_debugbridge/src/server.js"]
startup_timeout_sec = 30.0

[mcp_servers.ui_lookin_debugbridge.env]
BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKIN_CLI_PATH = "lookin-cli"
LOOKIN_MODE = "simulator"
LOOKIN_HOST = "127.0.0.1"
LOOKIN_SCREENSHOT_COMMAND = "xcrun simctl io booted screenshot {output}"
```

真机把 `LOOKIN_MODE` 改为 `device`，并补充：

```toml
LOOKDEBUG_DEVICE_UDID = "<your-device-udid>"
IPROXY_PATH = "iproxy"
LOOKIN_LOCAL_PORT = "47175"
LOOKIN_REMOTE_PORT = "47175"
BRIDGE_LOCAL_PORT = "37777"
BRIDGE_REMOTE_PORT = "37777"
```

重启 Codex 或新建任务，然后启动 Debug App。真机先调用 `ensure_ports`，再依次调用 `ping`、`get_debug_page` 和 `inspect_ui`。能列出 MCP 工具不代表 App 端已经连通。

## 工作方式

```text
Codex / MCP Client
        │ stdio
        ▼
ui_lookin_debugbridge（本仓库，运行在 Mac）
        ├── lookin-cli ──► LookinServer ──► 读取 UI 层级（47175）
        ├── HTTP ────────► LookDebugBridge ─► 页面语义和稳定 ID 操作（37777）
        ├── Accessibility ────────────────► Xcode Debug Console
        └── 外部截图命令 ────────────────► 截图文件
```

连接模拟器时，MCP 直接访问本机端口；连接真机时，通过 `iproxy` 转发 `47175` 和 `37777`。

## 接入总览

完整接入包含两部分：

1. **iOS App 侧**：通过 CocoaPods 接入 `LookDebugBridge`，启动服务，并为页面注册稳定元素 ID。
2. **Mac 侧**：安装本仓库及 `lookin-cli`，配置 MCP Client；真机模式还需安装 `iproxy`。

建议先完成 iOS 端，再配置 Mac 端，最后按“验收接入”章节逐项验证。

两个仓库的职责不要混淆：

| 仓库 | 安装位置 | 职责 |
| --- | --- | --- |
| `LookDebugBridge` | iOS App / CocoaPods | 暴露页面语义、稳定元素 ID 和操作接口 |
| `ui_lookin_debugbridge` | Mac / MCP Client | 汇总 DebugBridge、Lookin、端口转发、Console 和截图能力 |

## 一、iOS App 接入

### 1. 添加 Pod

推荐从独立的 iOS 仓库接入，仅在 Debug 配置中编译：

```ruby
platform :ios, '14.0'

target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge',
      :git => 'git@github.com:Immmmmmortal1/LookDebugBridge.git',
      :configurations => ['Debug']
end
```

然后执行：

```bash
pod install
```

`LookDebugBridge.podspec` 已依赖 `LookinServer/Swift`，通常不需要再单独声明 `LookinServer`。

如果你正在同时开发 MCP 与 iOS Bridge，也可以把本仓库作为本地 Pod：

```ruby
pod 'LookDebugBridge',
    :path => '../ui_lookin_debugbridge',
    :configurations => ['Debug']
```

### 2. 启动 Bridge

在 `AppDelegate`、`SceneDelegate` 或首个页面中启动。import 和启动代码都应限制在 Debug 构建：

```swift
import UIKit

#if DEBUG
import LookDebugBridge
#endif

func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) -> Bool {
    #if DEBUG
    Task { @MainActor in
        LookDebugBridge.shared.startIfNeeded()
    }
    #endif

    return true
}
```

Bridge 默认监听 `37777`，提供以下 HTTP 接口：

```text
GET  /ping
GET  /debug/page
POST /debug/tap
POST /debug/switch
POST /debug/text/set
POST /debug/text/type
```

### 3. 注册页面和元素

页面实现 `LookDebugPageDescribing`，把允许 AI 操作的控件注册为稳定 ID。ID 不要依赖坐标、文案或视图层级。

```swift
#if DEBUG
import LookDebugBridge

extension AutomationTestViewController: LookDebugPageDescribing {
    var lookDebugPageID: String {
        "automation.test"
    }

    var lookDebugPageTitle: String {
        title ?? "自动化测试页"
    }

    func registerLookDebugElements(in registry: LookDebugElementRegistry) {
        registry.register(
            view: primaryButton,
            id: "AutomationTest.primaryButton",
            type: .button,
            label: "主按钮"
        )

        registry.register(
            view: toggleSwitch,
            id: "AutomationTest.toggleSwitch",
            type: .switch,
            label: "测试开关"
        )
    }
}
#endif
```

接入原则：

- 页面 ID 和元素 ID 一经使用尽量保持稳定。
- 只注册允许自动化操作的控件。
- 优先通过既有 `UIControl` 事件执行操作，不绕过业务逻辑直接修改状态。
- 文本输入只支持真实 `UITextField` / `UITextView`；`set` 替换全文，`type` 追加文本，并触发编辑事件。
- Release 包不应启动 Bridge。

## 二、Mac 侧 MCP 接入

### 1. 安装依赖

基础要求：

- Node.js 18 或更高版本
- `lookin-cli`，负责读取 Lookin UI 层级
- 真机模式需要 `iproxy`（通常由 `libimobiledevice` 提供）
- 使用 Xcode Console 工具时，Xcode 必须正在运行，并为 Codex/启动 MCP 的终端授予 macOS“辅助功能”权限

确认命令可用：

```bash
command -v node
command -v lookin-cli
command -v iproxy # 仅真机模式必需
```

### 2. 安装 MCP Server

```bash
git clone git@github.com:Immmmmmortal1/ui_lookin_debugbridge.git
cd ui_lookin_debugbridge
npm run build
npm test
```

本项目当前没有第三方 npm 运行时依赖，不需要常驻执行 `npm install`。`npm run build` 会检查源码语法，`npm test` 会运行自动化测试。

### 3. 配置 Codex

在 `~/.codex/config.toml` 中添加配置。请把仓库路径替换为本机绝对路径。

先获取实际命令路径：

```bash
command -v node
command -v lookin-cli
command -v iproxy # 仅真机模式必需
```

#### 模拟器配置

```toml
[mcp_servers.ui_lookin_debugbridge]
command = "/opt/homebrew/bin/node"
args = ["/absolute/path/ui_lookin_debugbridge/src/server.js"]
startup_timeout_sec = 30.0

[mcp_servers.ui_lookin_debugbridge.env]
BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKIN_CLI_PATH = "lookin-cli"
LOOKIN_MODE = "simulator"
LOOKIN_HOST = "127.0.0.1"
LOOKIN_SCREENSHOT_COMMAND = "xcrun simctl io booted screenshot {output}"
```

#### 真机配置

先获取设备 UDID：

```bash
xcrun xctrace list devices
```

再添加配置：

```toml
[mcp_servers.ui_lookin_debugbridge]
command = "/opt/homebrew/bin/node"
args = ["/absolute/path/ui_lookin_debugbridge/src/server.js"]
startup_timeout_sec = 30.0

[mcp_servers.ui_lookin_debugbridge.env]
BRIDGE_BASE_URL = "http://127.0.0.1:37777"
LOOKIN_CLI_PATH = "lookin-cli"
LOOKIN_MODE = "device"
LOOKIN_HOST = "127.0.0.1"
LOOKDEBUG_DEVICE_UDID = "<your-device-udid>"
IPROXY_PATH = "iproxy"
LOOKIN_LOCAL_PORT = "47175"
LOOKIN_REMOTE_PORT = "47175"
BRIDGE_LOCAL_PORT = "37777"
BRIDGE_REMOTE_PORT = "37777"
LOOKIN_SCREENSHOT_COMMAND = ""
```

如果 `node`、`lookin-cli` 或 `iproxy` 不在默认 PATH 中，请填写绝对路径。Apple Silicon Homebrew 的 Node 常见路径是 `/opt/homebrew/bin/node`，请以 `command -v node` 的结果为准。

修改配置后，重新启动 Codex 或新建任务，使 MCP Server 重新加载。

安全提示：不要把访问令牌、签名证书或其他密钥写进本仓库。设备 UDID 可以放在本机 MCP 配置中，不必提交到 Git。

### 4. 其他 MCP Client

本服务使用 stdio 传输。其他支持 MCP 的客户端只需配置：

```text
command: node
args: /absolute/path/ui_lookin_debugbridge/src/server.js
```

并传入上一节中对应模拟器或真机的环境变量。

## 三、验收接入

### 1. 启动 App

使用 Debug 配置从 Xcode 启动 App，并确认：

- `LookinServer` 已加载。
- `LookDebugBridge` 已启动并监听 `37777`。
- 当前页面实现了 `LookDebugPageDescribing`，且至少注册了一个元素。

### 2. 真机建立端口转发

真机模式优先调用 MCP 工具：

```json
{"name":"ensure_ports","arguments":{}}
```

也可以手动执行：

```bash
iproxy -u <your-device-udid> 47175:47175
iproxy -u <your-device-udid> 37777:37777
```

模拟器模式不需要 `iproxy`。

### 3. 按能力逐项验证

工具出现在 `tools/list` 中只代表 MCP 已注册，不代表 App、Lookin 或 DebugBridge 已连通。建议依次验证：

1. `ensure_ports`：真机端口转发可用；模拟器跳过。
2. `run_xcode_active_scheme`：需要自动运行时，激活当前 Xcode 窗口并发送 `Command+R`，不要用第二套 `xcodebuild`/Debugger 抢当前 Console。
3. `ping`：分别检查返回值中的 `debugBridge` 和 `lookin`，不要只看聚合 `success`。
4. `get_debug_page`：能返回非空 `pageID` 和元素列表。
5. `run_flow` 或安全元素操作：能执行稳定 ID 操作并读取操作后的页面状态。
6. `inspect_ui`：能返回当前 Lookin UI 层级。
7. `read_xcode_console`：需要时确认 Xcode Console 可读。
8. 目标业务流程：账号、数据和页面入口均可到达。

验收结果应明确为：

- **完整可用**：当前任务需要的页面读取、元素操作、UI 层级、Console 和目标流程都验证成功。
- **部分可用**：部分能力成功、部分失败；逐项说明结果，例如 DebugBridge 可操作但 Lookin 层级读取失败。
- **不可用**：任务依赖的核心页面读取或操作链路不可用，且没有替代路径。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ping` | 聚合检查 DebugBridge 与 Lookin；调用方应读取各子项结果 |
| `ensure_ports` | 真机模式启动或复用 `iproxy` 端口转发 |
| `run_xcode_active_scheme` | 激活 Xcode 当前窗口，并用 `Command+R` 运行当前选中的 scheme |
| `inspect_ui` | 通过 `lookin-cli` 读取 UI 层级 |
| `get_debug_page` | 读取当前页面 ID、标题和已注册元素 |
| `tap_element` | 按稳定 ID 点击元素 |
| `set_switch` | 按稳定 ID 明确设置开关状态 |
| `set_text` | 按稳定 ID 替换 `UITextField` / `UITextView` 文本 |
| `type_text` | 按稳定 ID 向 `UITextField` / `UITextView` 追加文本 |
| `run_flow` | 执行等待、点击、设置开关等多步流程，并可保存 trace |
| `audit_runtime` | 将 Figma raw 数据与运行态元素做语义对齐 |
| `read_xcode_console` | 筛选并读取当前 Xcode Debug Console |
| `wait_xcode_console` | 等待调用后新增的匹配 Console 日志 |
| `get_screenshot` | 通过配置的外部命令获取截图 |

兼容旧工具名：

- `get_page` 等同 `get_debug_page`
- `get_ui_hierarchy` 等同 `inspect_ui`，并请求 JSON 输出

工具返回格式统一为：

```json
{
  "source": "http_bridge | lookin_cli | screenshot_command",
  "success": true,
  "payload": {},
  "error": null
}
```

## 常用示例

读取当前页面：

```json
{"name":"get_debug_page","arguments":{"expectedPageID":"automation.test"}}
```

点击按钮：

```json
{"name":"tap_element","arguments":{"id":"AutomationTest.primaryButton"}}
```

设置开关：

```json
{"name":"set_switch","arguments":{"id":"AutomationTest.toggleSwitch","isOn":true}}
```

输入文本：

```json
{"name":"set_text","arguments":{"id":"photoComment.input","text":"Hi"}}
```

```json
{"name":"type_text","arguments":{"id":"photoComment.input","text":"!"}}
```

运行 Xcode 当前 scheme：

```json
{"name":"run_xcode_active_scheme","arguments":{"waitForReady":true,"readyTimeoutMs":60000}}
```

`run_xcode_active_scheme` 不调用 `xcodebuild`，也不连接第二个 LLDB；它会把 Xcode 激活到前台，然后发送 `Command+R`，因此 Console 与 Debugger 保持在用户当前 Xcode 会话里。

执行流程并保存 artifact：

```json
{
  "name": "run_flow",
  "arguments": {
    "steps": [
      { "action": "wait_for_page", "pageID": "automation.test" },
      { "action": "tap", "id": "AutomationTest.primaryButton" }
    ],
    "saveArtifacts": true,
    "artifactDir": ".devflow-ui/runtime",
    "artifactPrefix": "automation-test"
  }
}
```

读取 Xcode Console：

```json
{"name":"read_xcode_console","arguments":{"query":"[Log]","maxResults":20,"maxCharsPerLine":2000}}
```

```json
{"name":"wait_xcode_console","arguments":{"query":"启动完成","timeoutMs":30000,"intervalMs":1000}}
```

`read_xcode_console` 和 `wait_xcode_console` 会先激活 Xcode，再读取 Xcode 已有 Debug Console；它们不连接第二个 LLDB，也不使用 `idevicesyslog`。工具只在本机筛选结果，不保存 Console 历史副本。

运行态与 Figma 语义校对：

```json
{
  "name": "audit_runtime",
  "arguments": {
    "figmaRawPath": ".devflow-ui/figma/result-page.raw.json",
    "expectedPageID": "automation.test",
    "artifactDir": ".devflow-ui/runtime",
    "artifactPrefix": "automation-test"
  }
}
```

`needsMapping` 表示需要人工复核，不等同于已确认缺失 UI。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_BASE_URL` | `http://127.0.0.1:37777` | DebugBridge HTTP 地址 |
| `LOOKIN_CLI_PATH` | `lookin-cli` | `lookin-cli` 命令或绝对路径 |
| `LOOKIN_MODE` | `device` | `device` 或 `simulator` |
| `LOOKIN_HOST` | `127.0.0.1` | Lookin 服务地址 |
| `LOOKDEBUG_DEVICE_UDID` | 空 | 真机 UDID |
| `IPROXY_PATH` | `iproxy` | `iproxy` 命令或绝对路径 |
| `LOOKIN_LOCAL_PORT` | `47175` | Lookin 本地端口 |
| `LOOKIN_REMOTE_PORT` | `47175` | Lookin 设备端口 |
| `BRIDGE_LOCAL_PORT` | `37777` | DebugBridge 本地端口 |
| `BRIDGE_REMOTE_PORT` | `37777` | DebugBridge 设备端口 |
| `LOOKIN_SCREENSHOT_COMMAND` | 空 | 截图命令，使用 `{output}` 作为输出路径占位符 |

## 故障排查

### MCP 工具没有出现

- 检查 `config.toml` 中的 Node 和 `src/server.js` 是否为绝对路径。
- 在仓库中运行 `npm run build` 和 `npm test`。
- MCP Server 使用 stdio，直接启动后没有普通终端输出属于正常现象。
- 修改配置后重启 MCP Client 或新建任务。

### `get_debug_page` 连接失败

- 确认使用 Debug 构建，且调用了 `LookDebugBridge.shared.startIfNeeded()`。
- 模拟器确认 App 正在运行；真机确认 `37777:37777` 转发成功。
- 确认 `BRIDGE_BASE_URL` 为 `http://127.0.0.1:37777`。

### `get_debug_page` 返回页面但没有元素

- 当前页面需要实现 `LookDebugPageDescribing`。
- 在 `registerLookDebugElements` 中注册控件。
- 确认注册的控件已进入当前视图层级。

### `get_runtime_node` 按 Figma runtime-anchor 查运行时控件

`get_runtime_node` 不依赖 `LookDebugPageDescribing` 注册表。它直接在 App 进程内遍历当前 `UIWindow` / `UIView.subviews`，匹配：

```swift
view.accessibilityIdentifier == "figma.1739_13055"
```

调用示例：

```json
{
  "anchor": "figma.1739_13055",
  "saveArtifact": true,
  "artifactDir": ".devflow-ui/runtime"
}
```

返回内容包含 `found`、`unique`、`matchCount`、`className`、`frameInWindow`、`hidden`、`alpha`、`text`、`fontName`、`fontSize`、`textColor`、`backgroundColor`、`cornerRadius`、`imageAssetName`、`controlEnabled` 等字段，可作为 UI 实现校对的 `runtime_detail.json` 证据。

图片资源名需要 App 侧显式绑定：

```swift
imageView.image = UIImage(named: "figma_1739_12994_male")
imageView.lookDebugAssetName = "figma_1739_12994_male"
```

### `inspect_ui` 失败

- 确认 `lookin-cli` 可执行。
- 确认 App 已集成并启动 `LookinServer`。
- 真机确认 `47175:47175` 转发成功，且 `LOOKIN_MODE=device`。
- 模拟器确认 `LOOKIN_MODE=simulator`。

### Xcode Console 读取失败

- 确认 Xcode 正在运行且 Debug Area 中已显示 Console。
- 在“系统设置 → 隐私与安全性 → 辅助功能”中授权 Codex 或启动 MCP 的终端。
- Xcode 清空或截断 Console 后，MCP 不会恢复历史内容。

### 自动运行与手动 Xcode 冲突

- 使用 `run_xcode_active_scheme`，不要让自动化工具直接调用 `xcodebuild`/`build_run_device` 去启动第二个调试会话。
- 确认 Xcode 当前选中的 scheme、Run configuration 和目标设备正确；该工具执行的就是当前 Xcode 窗口里的 `Command+R`。
- 如果看不到新的 `LookDebugBridge ready`，检查 Run configuration 是否为 Debug，以及 AppDelegate 是否调用了 `LookDebugBridge.shared.startIfNeeded()`。

## 本地开发

```bash
npm run build
npm test
npm start
```

这是一个 stdio MCP Server，支持：

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

## 限制

- 只建议用于 Debug 构建，不建议在 Release 包中启用。
- `inspect_ui` 只负责读取层级；操作通过 DebugBridge 的稳定 ID 完成，不支持坐标点击。
- `get_screenshot` 依赖外部截图命令，不直接复用 `lookin-cli`。
- 系统权限弹窗不在 App 进程内，DebugBridge 不负责操作。
- Xcode Console 能力依赖 macOS Accessibility 权限和 Xcode 当前界面状态。
