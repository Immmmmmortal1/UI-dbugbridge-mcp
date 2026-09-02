import UIKit

enum LookDebugPageProviderError: Error, Equatable {
    case pageUnavailable
}
@MainActor
struct LookDebugPageProvider {
    func payload(for viewController: UIViewController?) throws -> LookDebugPagePayload {
        let resolved = try resolvedPage(for: viewController)
        return resolved.payload
    }

    func resolvedPage(for viewController: UIViewController?) throws -> ResolvedLookDebugPage {
        let registry = LookDebugElementRegistry()
        guard let viewController else {
            throw LookDebugPageProviderError.pageUnavailable
        }

        let pageID: String
        let title: String
        if let page = viewController as? LookDebugPageDescribing {
            page.registerLookDebugElements(in: registry)
            pageID = page.lookDebugPageID
            title = page.lookDebugPageTitle
        } else {
            pageID = normalizedPageID(for: viewController)
            title = viewController.title ?? String(describing: type(of: viewController))
        }

        registerContainedTabBarControllerElements(in: viewController, registry: registry)

        scanRoots(for: viewController).enumerated().forEach { index, rootView in
            registerAccessibilityElements(
                in: rootView,
                registry: registry,
                pageID: pageID,
                path: ["root\(index)"],
                ancestorVisible: true
            )
        }
        let elements = registry.allMetadata
        guard !elements.isEmpty else {
            throw LookDebugPageProviderError.pageUnavailable
        }

        return ResolvedLookDebugPage(
            payload: LookDebugPagePayload(
                pageID: pageID,
                title: title,
                elements: elements
            ),
            registry: registry
        )
    }

    private func scanRoots(for viewController: UIViewController) -> [UIView] {
        if let tabBarView = viewController.tabBarController?.view,
           tabBarView.window != nil {
            return [tabBarView]
        }

        if let navigationView = viewController.navigationController?.view,
           navigationView.window != nil {
            return [navigationView]
        }

        return [viewController.view]
    }

    private func registerAccessibilityElements(
        in view: UIView,
        registry: LookDebugElementRegistry,
        pageID: String,
        path: [String],
        ancestorVisible: Bool
    ) {
        let isVisible = ancestorVisible && !view.isHidden && view.alpha > 0.01
        let explicitID = sanitizedID(view.accessibilityIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines))
        let generatedID = generatedID(for: view, pageID: pageID, path: path)

        if isVisible, let tabBar = view as? UITabBar {
            // iOS 26 tabs 模式下，TabBar 按钮已由 registerTabBarControllerElements 通过 UITab API 注册；
            // 这里再遍历 UITabBar.subviews 会用无 tapAction 的私有 UIControl 覆盖已注册的 index id。
            if #available(iOS 26.0, *) {
                let responderChainTabBarController = findTabBarController(for: tabBar)
                if let tbc = responderChainTabBarController, !tbc.tabs.isEmpty {
                    return
                }
            }
            registerTabBarElements(tabBar, registry: registry)
            return
        }

        let id = (explicitID?.isEmpty == false) ? explicitID : generatedID
        if isVisible, let id {
            registry.register(
                view: view,
                id: id,
                type: elementType(for: view),
                label: debugLabel(for: view, fallback: id)
            )
        }

        if isVisible, let id {
            registerVisibleCells(in: view, containerID: id, registry: registry)
        }

        for (index, subview) in view.subviews.enumerated() {
            registerAccessibilityElements(
                in: subview,
                registry: registry,
                pageID: pageID,
                path: path + [pathComponent(for: subview, index: index)],
                ancestorVisible: isVisible
            )
        }
    }

    private func registerContainedTabBarControllerElements(
        in viewController: UIViewController,
        registry: LookDebugElementRegistry
    ) {
        for tabBarController in tabBarControllers(containedIn: viewController) where tabBarController.view.window != nil {
            registerTabBarControllerElements(tabBarController, registry: registry)
        }
    }

    private func tabBarControllers(containedIn viewController: UIViewController) -> [UITabBarController] {
        var result: [UITabBarController] = []
        if let tabBarController = viewController as? UITabBarController {
            result.append(tabBarController)
        }
        for child in viewController.children {
            result.append(contentsOf: tabBarControllers(containedIn: child))
        }
        return result
    }

    /// 通过 responder chain 从 UITabBar 找到所属的 UITabBarController。
    /// 用于在 UI 树遍历时判断 UITabBar 是否属于 iOS 26 tabs 模式的 controller。
    private func findTabBarController(for tabBar: UITabBar) -> UITabBarController? {
        var responder: UIResponder? = tabBar
        while let current = responder {
            if let tabBarController = current as? UITabBarController {
                return tabBarController
            }
            responder = current.next
        }
        return nil
    }

    private func registerTabBarControllerElements(
        _ tabBarController: UITabBarController,
        registry: LookDebugElementRegistry
    ) {
        // iOS 26+ 的 UITabBarController 使用 mode = .tabBar + tabs: [UITab] 新 API，
        // 此时 viewControllers 返回 nil，旧路径会直接 guard 退出。
        // 这里通过 tabs: [UITab] 注册，点击时设置 selectedTab = tab，与 app 端切换方式一致。
        // id 命名约定与旧路径对齐（index-based + title-based + identifier-based），保证兼容。
        if #available(iOS 26.0, *), !tabBarController.tabs.isEmpty {
            let tabs = tabBarController.tabs
            for (index, tab) in tabs.enumerated() {
                let rawTitle = tab.title.trimmingCharacters(in: .whitespacesAndNewlines)
                let title = rawTitle.isEmpty ? "Tab \(index)" : rawTitle
                var ids = [
                    "tabbarviewcontroller.tabbar.item\(index)"
                ]

                if !rawTitle.isEmpty {
                    ids.append("tabbarviewcontroller.tabbar.\(normalizedComponent(rawTitle))")
                }

                let tabID = sanitizedID(tab.identifier.trimmingCharacters(in: .whitespacesAndNewlines))
                if let tabID, !tabID.isEmpty {
                    ids.append(tabID)
                }

                for id in Set(ids) {
                    registry.register(
                        view: tabBarController.view,
                        id: id,
                        type: .button,
                        label: title
                    ) { [weak tabBarController, weak tab] in
                        guard let tabBarController, let tab else { return }
                        // 对齐旧路径的 delegate 调用：先 shouldSelect 拦截，再切换，再 didSelect 同步业务状态。
                        // app 端 SystemMainTabBarController 依赖 didSelectTab 做 markChatRead / 通知 parent / 更新 accessibility。
                        if tabBarController.delegate?.tabBarController?(tabBarController, shouldSelectTab: tab) == false {
                            return
                        }
                        let previousTab = tabBarController.selectedTab
                        tabBarController.selectedTab = tab
                        tabBarController.delegate?.tabBarController?(tabBarController, didSelectTab: tab, previousTab: previousTab)
                    }
                }
            }
            return
        }

        guard let viewControllers = tabBarController.viewControllers else { return }

        for (index, target) in viewControllers.enumerated() {
            let item = target.tabBarItem
            let rawTitle = item?.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = rawTitle?.isEmpty == false ? rawTitle! : "Tab \(index)"
            var ids = [
                "tabbarviewcontroller.tabbar.item\(index)"
            ]

            if let title = rawTitle, !title.isEmpty {
                ids.append("tabbarviewcontroller.tabbar.\(normalizedComponent(title))")
            }

            if let itemID = sanitizedID(item?.accessibilityIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)),
               !itemID.isEmpty {
                ids.append(itemID)
            }

            for id in Set(ids) {
                registry.register(
                    view: tabBarController.view,
                    id: id,
                    type: .button,
                    label: title
                ) { [weak tabBarController, weak target] in
                    guard let tabBarController, let target else { return }
                    if tabBarController.delegate?.tabBarController?(tabBarController, shouldSelect: target) == false {
                        return
                    }
                    tabBarController.selectedIndex = index
                    tabBarController.delegate?.tabBarController?(tabBarController, didSelect: target)
                }
            }
        }
    }

    private func registerTabBarElements(_ tabBar: UITabBar, registry: LookDebugElementRegistry) {
        let buttons = tabBar.subviews
            .compactMap { $0 as? UIControl }
            .filter { !$0.isHidden && $0.alpha > 0.01 }
            .sorted { $0.frame.minX < $1.frame.minX }
        let items = tabBar.items ?? []

        for (index, button) in buttons.enumerated() {
            let rawTitle = items.indices.contains(index) ? items[index].title : nil
            let title = rawTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = title?.isEmpty == false ? title! : "Tab \(index)"

            registry.register(
                view: button,
                id: "tabbarviewcontroller.tabbar.item\(index)",
                type: .button,
                label: label
            )

            if let title, !title.isEmpty {
                registry.register(
                    view: button,
                    id: "tabbarviewcontroller.tabbar.\(normalizedComponent(title))",
                    type: .button,
                    label: title
                )
            }
        }
    }

    private func registerVisibleCells(in view: UIView, containerID: String, registry: LookDebugElementRegistry) {
        if let collectionView = view as? UICollectionView {
            let indexPaths = collectionView.indexPathsForVisibleItems.sorted()
            for indexPath in indexPaths {
                guard let cell = collectionView.cellForItem(at: indexPath),
                      !cell.isHidden,
                      cell.alpha > 0.01 else {
                    continue
                }
                let id = "\(containerID).cell.section\(indexPath.section).item\(indexPath.item)"
                registry.register(
                    view: cell,
                    id: id,
                    type: .cell,
                    label: debugLabel(for: cell, fallback: id)
                )
            }
            return
        }

        if let tableView = view as? UITableView {
            let indexPaths = tableView.indexPathsForVisibleRows ?? []
            for indexPath in indexPaths.sorted() {
                guard let cell = tableView.cellForRow(at: indexPath),
                      !cell.isHidden,
                      cell.alpha > 0.01 else {
                    continue
                }
                let id = "\(containerID).cell.section\(indexPath.section).row\(indexPath.row)"
                registry.register(
                    view: cell,
                    id: id,
                    type: .cell,
                    label: debugLabel(for: cell, fallback: id)
                )
            }
        }
    }

    private func generatedID(for view: UIView, pageID: String, path: [String]) -> String? {
        guard view is UIControl || view is UICollectionView || view is UITableView else { return nil }
        return ([pageID, "auto"] + path).joined(separator: ".")
    }

    private func pathComponent(for view: UIView, index: Int) -> String {
        "\(String(describing: type(of: view)).lowercased())\(index)"
    }

    private func elementType(for view: UIView) -> LookDebugElementType {
        if view is UITextField || view is UITextView {
            return .text
        }
        if view is UISwitch {
            return .switch
        }
        if view is UIControl {
            return .button
        }
        if view is UICollectionViewCell || view is UITableViewCell {
            return .cell
        }
        if view is UILabel {
            return .label
        }
        return .view
    }

    private func debugLabel(for view: UIView, fallback: String) -> String {
        if let accessibilityLabel = view.accessibilityLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           !accessibilityLabel.isEmpty {
            return accessibilityLabel
        }
        if let button = view as? UIButton,
           let title = button.title(for: .normal),
           !title.isEmpty {
            return title
        }
        if let label = view as? UILabel,
           let text = label.text,
           !text.isEmpty {
            return text
        }
        return fallback
    }

    private func normalizedPageID(for viewController: UIViewController) -> String {
        normalizedComponent(String(describing: type(of: viewController)))
    }

    private func normalizedComponent(_ raw: String) -> String {
        let filtered = raw.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) {
                return Character(String(scalar).lowercased())
            }
            return "."
        }
        let collapsed = String(filtered)
            .split(separator: ".")
            .filter { !$0.isEmpty }
            .joined(separator: ".")
        return collapsed.isEmpty ? "unnamed" : collapsed
    }

    private func sanitizedID(_ id: String?) -> String? {
        guard let id, !id.isEmpty else { return id }
        return id
            .split(separator: ".")
            .map(String.init)
            .filter { $0 != "lazy" && $0 != "storage" }
            .joined(separator: ".")
    }
}

struct ResolvedLookDebugPage {
    let payload: LookDebugPagePayload
    let registry: LookDebugElementRegistry
}
