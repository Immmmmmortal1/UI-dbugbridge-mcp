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

    private func registerTabBarControllerElements(
        _ tabBarController: UITabBarController,
        registry: LookDebugElementRegistry
    ) {
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
