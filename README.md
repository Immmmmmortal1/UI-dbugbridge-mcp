# LookDebugBridge

`LookDebugBridge` 是一套给 AI/脚本调试 iOS App 的双端工具：

- Mac 侧：`lookdebug-mcp`，提供 MCP tools
- iOS 侧：`LookDebugBridge` Pod，随 Debug App 编译运行

整体链路：

- `LookinServer` / `lookin-cli`：负责读取 UI 层级
- `LookDebugBridge`：负责页面语义与稳定 ID 操作
- `iproxy`：负责把真机端口转发到本机

## Mac 侧 MCP 能力

- `ping`：检查 `lookin-cli` 和 DebugBridge 是否可用
- `ensure_ports`：在真机模式下拉起 `47175` 和 `37777` 的 `iproxy`
- `inspect_ui`：通过 `lookin-cli` 读取 UI 层级
- `get_debug_page`：读取 DebugBridge 注册的页面与元素 ID，可选校验 `expectedPageID` 并保存 artifact
- `tap_element`：按稳定 ID 点击控件
- `set_switch`：按稳定 ID 明确设置开关状态
- `run_flow`：按稳定 ID/label 执行链路，支持等待页面/元素，可选保存 flow trace 和最终页面 artifact
- `audit_runtime`：读取当前 DebugBridge 页面，并将 Figma raw 与运行态元素做语义对齐，输出 JSON/Markdown 报告
- `get_screenshot`：通过外部截图命令获取截图

兼容旧工具名：

- `get_page`：等同 `get_debug_page`
- `get_ui_hierarchy`：等同 `inspect_ui`，并请求 JSON 输出

返回格式统一为：

```json
{
  "source": "http_bridge | lookin_cli | screenshot_command",
  "success": true,
  "payload": {},
  "error": null
}
```

## iOS 侧 Pod 接入

### 1. Podfile

本地开发时：

```ruby
target 'YourApp' do
  use_frameworks!

  pod 'LookDebugBridge', :path => '../ui_lookin_debugbridge', :configurations => ['Debug']
end
```

`LookDebugBridge.podspec` 已依赖 `LookinServer/Swift`，所以不需要重复声明 `LookinServer`。如果你希望自己控制 LookinServer 版本，也可以在 Podfile 里单独声明。

### 2. 启动 Bridge

在 Debug 包启动后调用：

```swift
#if DEBUG
import LookDebugBridge
#endif

// AppDelegate / SceneDelegate / 首个 ViewController 均可
#if DEBUG
Task { @MainActor in
    LookDebugBridge.shared.startIfNeeded()
}
#endif
```

启动成功后会监听：

```text
37777
```

MCP 会访问：

```text
GET  /ping
GET  /debug/page
POST /debug/tap
POST /debug/switch
```

### 3. 页面注册可操作元素

页面需要实现 `LookDebugPageDescribing`，把 AI 可操作的控件注册进来：

```swift
#if DEBUG
import LookDebugBridge
#endif

final class AutomationTestViewController: UIViewController {
    private let primaryButton = UIButton(type: .system)
    private let toggleSwitch = UISwitch()
}

#if DEBUG
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

之后 MCP 就可以调用：

```json
{"name":"tap_element","arguments":{"id":"AutomationTest.primaryButton"}}
```

```json
{"name":"set_switch","arguments":{"id":"AutomationTest.toggleSwitch","isOn":true}}
```

### 4. UI 校对接口

`get_debug_page` 支持 artifact 保存和页面校验，减少调用方猜当前页面的成本：

```json
{
  "name": "get_debug_page",
  "arguments": {
    "expectedPageID": "airesultviewcontroller",
    "saveArtifact": true,
    "artifactDir": ".devflow-ui/runtime",
    "artifactPrefix": "ai-result"
  }
}
```

`run_flow` 支持保存链路 trace 和最终页面：

```json
{
  "name": "run_flow",
  "arguments": {
    "steps": [
      { "action": "wait_for_page", "pageID": "mineviewcontroller" },
      { "action": "tap", "idIncludes": "message" },
      { "action": "wait_for_page", "pageID": "notifications" }
    ],
    "saveArtifacts": true,
    "artifactDir": ".devflow-ui/runtime",
    "artifactPrefix": "mine-message-flow"
  }
}
```

`audit_runtime` 是 Figma 与运行态语义校对入口。它会自动：

- 抓取当前 `/debug/page`
- 过滤 Figma 隐藏节点，例如 `visible=false` 或无 render bounds
- 按 label、稳定 ID、type 做保守匹配
- 输出 `present`、`needs_mapping`、extra candidates
- 写入 JSON 和 Markdown artifact

```json
{
  "name": "audit_runtime",
  "arguments": {
    "figmaRawPath": ".devflow-ui/figma/kakapic-result-page-481-14243.raw.json",
    "expectedPageID": "airesultviewcontroller",
    "artifactDir": ".devflow-ui/runtime",
    "artifactPrefix": "ai-result"
  }
}
```

返回的 `needsMapping` 是人工复核提示，不等于 confirmed missing UI。

## Mac 侧 MCP 配置

复制 `.env.example` 中的变量到你的本地环境：

```bash
BRIDGE_BASE_URL=http://127.0.0.1:37777
LOOKIN_CLI_PATH=lookin-cli
LOOKIN_MODE=device
LOOKIN_HOST=127.0.0.1
LOOKDEBUG_DEVICE_UDID=<your-device-udid>
IPROXY_PATH=iproxy
LOOKIN_LOCAL_PORT=47175
LOOKIN_REMOTE_PORT=47175
BRIDGE_LOCAL_PORT=37777
BRIDGE_REMOTE_PORT=37777
LOOKIN_SCREENSHOT_COMMAND=
```

说明：

- `LOOKIN_MODE=device` 会给 `lookin-cli` 追加 `--device`
- `LOOKIN_MODE=simulator` 会走模拟器模式
- `LOOKDEBUG_DEVICE_UDID` 用于 `ensure_ports` 自动执行 `iproxy -u <udid> local:remote`
- `LOOKIN_LOCAL_PORT/LOOKIN_REMOTE_PORT` 默认映射 `47175:47175`
- `BRIDGE_LOCAL_PORT/BRIDGE_REMOTE_PORT` 默认映射 `37777:37777`
- `LOOKIN_SCREENSHOT_COMMAND` 目前是一个可替换钩子，命令里用 `{output}` 作为输出图片路径占位符

示例：

```bash
LOOKIN_SCREENSHOT_COMMAND='xcrun simctl io booted screenshot {output}'
```

## 运行

```bash
cd ui_lookin_debugbridge
npm run build
npm start
```

这是一个 stdio MCP server，会响应：

- `initialize`
- `tools/list`
- `tools/call`

## 依赖前提

### 1. app 侧

- Debug 包已集成 `LookinServer`
- Debug 包已集成 `LookDebugBridge`
- app 启动后会打印：
  - `Lookin ready`
  - `LookDebugBridge ready`

### 2. 读取层级

需要本机能执行 `lookin-cli`。参考项目：

- `https://github.com/lyleLH/lookin-cli`

根据该项目 README，常用调用方式是：

```bash
lookin-cli --json --device
lookin-cli --json
```

### 3. 真机端口

真机模式下可以让 MCP 自动拉端口：

```json
{"name":"ensure_ports","arguments":{}}
```

也可以手动执行：

```bash
iproxy -u <your-device-udid> 47175:47175
iproxy -u <your-device-udid> 37777:37777
```

## MCP 使用流

推荐 AI/脚本按这个顺序使用：

1. `ensure_ports`
2. `ping`
3. `inspect_ui`
4. `get_debug_page`
5. `tap_element` 或 `set_switch`
6. `run_flow` 执行多步链路
7. `audit_runtime` 做 Figma-to-runtime 语义校对

示例工具调用参数：

```json
{"name":"inspect_ui","arguments":{"depth":4}}
```

```json
{"name":"tap_element","arguments":{"id":"AutomationTest.primaryButton"}}
```

```json
{"name":"set_switch","arguments":{"id":"AutomationTest.toggleSwitch","isOn":true}}
```

## 手动 smoke test

启动服务后，向 stdin 写入：

```text
Content-Length: 52

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

## 限制

- `get_screenshot` 目前依赖外部命令钩子，不直接复用 `lookin-cli`
- `inspect_ui` 只负责看，不负责操作
- 动作层只通过 DebugBridge 的稳定 ID 操作，不做坐标点击
- 只建议用于 Debug 包，不建议进 Release 包
