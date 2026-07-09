import UIKit

enum LookDebugActionExecutorError: Error, Equatable {
    case elementNotFound
    case unsupportedElementType
}

@MainActor
struct LookDebugActionExecutor {
    let registry: LookDebugElementRegistry

    func validateTappable(id: String) throws {
        let view = try tappableView(id: id)
        if view is UISwitch ||
            view is UICollectionViewCell ||
            view is UITableViewCell ||
            view is UIControl {
            return
        }
        throw LookDebugActionExecutorError.unsupportedElementType
    }

    func tap(id: String) throws {
        let view = try tappableView(id: id)

        if let switchControl = view as? UISwitch {
            switchControl.setOn(!switchControl.isOn, animated: true)
            switchControl.sendActions(for: .valueChanged)
            return
        }

        if let collectionCell = view as? UICollectionViewCell,
           let collectionView = collectionCell.lookDebugSuperview(of: UICollectionView.self),
           let indexPath = collectionView.indexPath(for: collectionCell) {
            collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
            collectionView.delegate?.collectionView?(collectionView, didSelectItemAt: indexPath)
            return
        }

        if let tableCell = view as? UITableViewCell,
           let tableView = tableCell.lookDebugSuperview(of: UITableView.self),
           let indexPath = tableView.indexPath(for: tableCell) {
            tableView.selectRow(at: indexPath, animated: false, scrollPosition: .none)
            tableView.delegate?.tableView?(tableView, didSelectRowAt: indexPath)
            return
        }

        guard let control = view as? UIControl else {
            throw LookDebugActionExecutorError.unsupportedElementType
        }

        if tapTabBarButton(control) {
            return
        }

        control.sendActions(for: .touchUpInside)
    }

    func setSwitch(id: String, isOn: Bool) throws {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }

        guard let switchControl = view as? UISwitch else {
            throw LookDebugActionExecutorError.unsupportedElementType
        }

        switchControl.setOn(isOn, animated: true)
        switchControl.sendActions(for: .valueChanged)
    }

    private func tappableView(id: String) throws -> UIView {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }
        return view
    }

    private func tapTabBarButton(_ control: UIControl) -> Bool {
        guard let tabBar = control.lookDebugSuperview(of: UITabBar.self),
              let tabBarController = tabBar.lookDebugOwningViewController() as? UITabBarController else {
            return false
        }

        let buttons = tabBar.subviews
            .compactMap { $0 as? UIControl }
            .filter { !$0.isHidden && $0.alpha > 0.01 }
            .sorted { $0.frame.minX < $1.frame.minX }

        guard let index = buttons.firstIndex(where: { $0 === control }),
              let viewControllers = tabBarController.viewControllers,
              viewControllers.indices.contains(index) else {
            return false
        }

        let target = viewControllers[index]
        if tabBarController.delegate?.tabBarController?(tabBarController, shouldSelect: target) == false {
            return true
        }

        tabBarController.selectedIndex = index
        tabBarController.delegate?.tabBarController?(tabBarController, didSelect: target)
        return true
    }
}

private extension UIView {
    func lookDebugSuperview<T: UIView>(of type: T.Type) -> T? {
        var current = superview
        while let view = current {
            if let matched = view as? T {
                return matched
            }
            current = view.superview
        }
        return nil
    }

    func lookDebugOwningViewController() -> UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let viewController = current as? UIViewController {
                return viewController
            }
            responder = current.next
        }
        return nil
    }
}
