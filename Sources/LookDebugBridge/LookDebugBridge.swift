import UIKit

/// 会话 ID 线程安全存储盒：NSLock 保护读写
/// 用 `static let` 持有不可变引用、内部 var 由 lock 保护，规避 nonisolated static var 并发告警
/// 真机 App 经 devicectl launch 无法注入环境变量，sessionID 需运行时可注入，故存储盒为可变
fileprivate final class LookDebugSessionBox {
    private let lock = NSLock()
    private var stored: String

    init(_ initial: String) { self.stored = initial }

    func get() -> String {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    func set(_ newValue: String) {
        lock.lock(); defer { lock.unlock() }
        stored = newValue
    }
}

@MainActor
public final class LookDebugBridge {
    public static let shared = LookDebugBridge()

    /// 会话 ID 初始值：从进程环境变量读取，读不到则 "local"
    /// 真机 App 经 devicectl launch 无法注入环境变量，运行时由 POST /debug/session 注入真实会话 id
    private nonisolated static let sessionBox = LookDebugSessionBox({
        let environment = ProcessInfo.processInfo.environment
        if let value = environment["DEV_FLOW_SESSION_ID"], value.isEmpty == false {
            return value
        }
        if let value = environment["CODEX_THREAD_ID"], value.isEmpty == false {
            return value
        }
        if let value = environment["CURSOR_CONVERSATION_ID"], value.isEmpty == false {
            return value
        }
        return "local"
    }())


    /// 当前 App bundle ID，用于 Mac 侧确认连到目标 App
    public nonisolated static var bundleID: String {
        Bundle.main.bundleIdentifier ?? "unknown"
    }

    /// 当前会话 ID（线程安全，可被运行时注入）
    /// - 初始值见 sessionBox：环境变量 DEV_FLOW_SESSION_ID / CODEX_THREAD_ID / CURSOR_CONVERSATION_ID
    /// - Mac 侧 MCP 通过 POST /debug/session 在确认桥后注入真实会话 id（修复真机 sessionID 恒为 local 的问题）
    public nonisolated static var sessionID: String {
        sessionBox.get()
    }

    /// 运行时注入会话 ID：trim 后非空才写入，空值忽略（保持现有值不变）
    /// 由 router 在 @MainActor 上下文调用，方法本身用 NSLock 保证跨线程安全
    public nonisolated static func setSessionID(_ newValue: String) {
        let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sessionBox.set(trimmed)
    }

    /// 桥接服务对外状态：idle → starting → ready / failed；failed 可重试
    public enum State: Equatable {
        case idle
        case starting
        case ready
        case failed
    }

    private let server: LookDebugBridgeServer
    private var state: State = .idle

    public convenience init(port: UInt16 = 37777) {
        // 可选 token：环境变量 LOOKDEBUG_TOKEN 配置后所有接口需校验 X-LookDebug-Token
        // 未配置时全部放行（兼容模式，保持现有用户不受影响）
        let token = ProcessInfo.processInfo.environment["LOOKDEBUG_TOKEN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedToken = (token?.isEmpty == false) ? token : nil
        self.init(server: LookDebugBridgeServer(port: port, token: normalizedToken))
    }

    public nonisolated static func log(
        _ message: String,
        level: String = "info",
        category: String = "app"
    ) {
        Task {
            await LookDebugLogStore.shared.append(
                level: level,
                category: category,
                message: message
            )
        }
    }

    init(server: LookDebugBridgeServer) {
        self.server = server
    }

    /// 当前桥接状态（只读）
    public var currentState: State { state }

    /// 当前监听端口（只读，与 init 时传入的 port 一致；默认 37777）
    public var activePort: UInt16 { server.activePort }

    public func startIfNeeded() {
        // Release 构建：库内二道防线，调用方应已 #if DEBUG 包裹
        #if !DEBUG
        print("[LookDebugBridge] DEBUG-only, skipped")
        return
        #endif

        // 仅 idle / failed 状态可启动；ready / starting 直接返回避免重复
        guard state == .idle || state == .failed else { return }
        state = .starting

        LookDebugAccessibilityInstaller.installIfNeeded()
        do {
            try server.start(
                currentViewControllerProvider: { [weak self] in
                    self?.currentViewController()
                },
                onStateChange: { [weak self] serverState in
                    self?.handleServerState(serverState)
                }
            )
        } catch {
            state = .failed
            Self.log("LookDebugBridge failed to start: \(error)", level: "error", category: "bridge")
            #if DEBUG
            print("[LookDebugBridge] FAILED to start: \(error)")
            #endif
        }
    }

    /// 处理 NWListener 状态变化：.ready 才标记启动成功；.failed/.cancelled 允许重试
    /// 双重保险：即使 server 端漏过上报 cancelled，这里也确保 failed 状态不被覆盖
    private func handleServerState(_ serverState: LookDebugBridgeServer.State) {
        switch serverState {
        case .ready:
            // ready 不是终态，允许后续 failed
            state = .ready
            Self.log("LookDebugBridge ready", category: "bridge")
            #if DEBUG
            print("[LookDebugBridge] ready")
            #endif
        case .failed:
            // failed 是终态，稳定保持，允许 startIfNeeded 重试
            state = .failed
            #if DEBUG
            print("[LookDebugBridge] listener failed, can retry startIfNeeded")
            #endif
        case .cancelled:
            // cancelled 是终态；仅在未进入 failed 时回到 idle（允许重试）
            // server 端已用 reachedTerminalState 保证 failed 后不会上报 cancelled，此处为双重保险
            if state != .failed {
                state = .idle
            }
        case .idle, .starting:
            break
        }
    }

    private func currentViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }

        let keyWindow = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)

        return topViewController(from: keyWindow?.rootViewController)
    }

    private func topViewController(from viewController: UIViewController?) -> UIViewController? {
        if let presentedViewController = viewController?.presentedViewController {
            return topViewController(from: presentedViewController)
        }
        if let navigationController = viewController as? UINavigationController {
            return topViewController(from: navigationController.visibleViewController)
        }
        if let tabBarController = viewController as? UITabBarController {
            return topViewController(from: tabBarController.selectedViewController)
        }
        if shouldDescendIntoCustomContainer(viewController),
           let visibleChild = viewController?.children.reversed().first(where: { child in
            child.isViewLoaded && child.view.window != nil && !child.view.isHidden && child.view.alpha > 0.01
        }) {
            return topViewController(from: visibleChild)
        }
        return viewController
    }

    private func shouldDescendIntoCustomContainer(_ viewController: UIViewController?) -> Bool {
        guard let viewController else { return false }
        return String(describing: type(of: viewController)) == "SecureWindowController"
    }
}
