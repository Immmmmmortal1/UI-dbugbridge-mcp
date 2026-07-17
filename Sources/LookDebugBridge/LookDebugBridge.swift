import UIKit

@MainActor
public final class LookDebugBridge {
    public static let shared = LookDebugBridge()

    private let server: LookDebugBridgeServer
    private var hasStarted = false

    public convenience init(port: UInt16 = 37777) {
        self.init(server: LookDebugBridgeServer(port: port))
    }

    init(server: LookDebugBridgeServer) {
        self.server = server
    }

    public func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true

        LookDebugAccessibilityInstaller.installIfNeeded()
        startLookinIfAvailable()

        do {
            try server.start { [weak self] in
                self?.currentViewController()
            }
            print("LookDebugBridge ready")
        } catch {
            print("LookDebugBridge failed to start: \(error)")
        }
    }

    private func startLookinIfAvailable() {
        guard let connectionManagerClass = NSClassFromString("LKS_ConnectionManager") else {
            print("LookinServer class not found")
            return
        }

        let manager = (connectionManagerClass as AnyObject)
            .perform(NSSelectorFromString("sharedInstance"))?
            .takeUnretainedValue() as? NSObject
        guard let manager else {
            print("LookinServer manager not available")
            return
        }

        // LookinServer 1.2.8 normally starts listening from UIApplicationDidBecomeActive.
        // If the bridge is initialized after that notification, explicitly restore the
        // active state and ask the existing manager to search its device port range.
        manager.setValue(true, forKey: "applicationIsActive")
        let listenSelector = NSSelectorFromString("searchPortToListenIfNoConnection")
        guard manager.responds(to: listenSelector) else {
            print("LookinServer listen selector not available")
            return
        }
        manager.perform(listenSelector)
        print("LookinServer listen requested")
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
