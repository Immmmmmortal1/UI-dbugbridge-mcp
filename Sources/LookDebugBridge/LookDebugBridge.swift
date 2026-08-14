import UIKit

@MainActor
public final class LookDebugBridge {
    public static let shared = LookDebugBridge(port: LookDebugPort.resolve())

    public nonisolated static let sessionID = {
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
    }()

    public nonisolated static let bundleID = Bundle.main.bundleIdentifier ?? "unknown"

    private let server: LookDebugBridgeServer
    private var hasStarted = false

    public convenience init(port: UInt16) {
        self.init(server: LookDebugBridgeServer(port: port))
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

    public func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true

        LookDebugAccessibilityInstaller.installIfNeeded()
        do {
            try server.start { [weak self] in
                self?.currentViewController()
            }
            Self.log("LookDebugBridge ready", category: "bridge")
        } catch {
            Self.log("LookDebugBridge failed to start: \(error)", level: "error", category: "bridge")
        }
    }

    var activePort: UInt16 { server.activePort }

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
