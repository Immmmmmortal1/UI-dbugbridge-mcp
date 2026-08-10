import UIKit

enum LookDebugActionExecutorError: Error, Equatable {
    case elementNotFound
    case unsupportedElementType
}

@MainActor
struct LookDebugActionExecutor {
    let registry: LookDebugElementRegistry

    func validateTappable(id: String) throws {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }
        if entry.hasTapAction {
            return
        }
        if view is UISwitch ||
            view is UICollectionViewCell ||
            view is UITableViewCell ||
            view is UIControl {
            return
        }
        throw LookDebugActionExecutorError.unsupportedElementType
    }

    func tap(id: String) throws {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }

        if entry.performTapActionIfAvailable() {
            return
        }

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
        // Some app controls (e.g. LovOnOverlayRouteButton) bind business actions via
        // accessibilityActivate/onActivate without a UIAction for touchUpInside.
        // Fall back so DebugBridge taps still reach those handlers once.
        if control is UIButton {
            _ = control.accessibilityActivate()
        }
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

    func setText(id: String, text: String, appending: Bool) throws -> String {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }

        if let textField = view as? UITextField {
            return try setTextFieldText(textField, text: text, appending: appending)
        }

        if let textView = view as? UITextView {
            return try setTextViewText(textView, text: text, appending: appending)
        }

        throw LookDebugActionExecutorError.unsupportedElementType
    }

    private func tappableView(id: String) throws -> UIView {
        guard let entry = registry.entry(for: id),
              let view = entry.view else {
            throw LookDebugActionExecutorError.elementNotFound
        }
        return view
    }

    private func setTextFieldText(_ textField: UITextField, text: String, appending: Bool) throws -> String {
        let current = textField.text ?? ""
        let next = appending ? current + text : text
        let range = appending
            ? NSRange(location: (current as NSString).length, length: 0)
            : NSRange(location: 0, length: (current as NSString).length)

        if textField.delegate?.textField?(textField, shouldChangeCharactersIn: range, replacementString: text) == false {
            throw LookDebugActionExecutorError.unsupportedElementType
        }

        textField.becomeFirstResponder()
        textField.text = next
        textField.accessibilityValue = next.isEmpty ? nil : next
        textField.sendActions(for: .editingChanged)
        return next
    }

    private func setTextViewText(_ textView: UITextView, text: String, appending: Bool) throws -> String {
        let current = textView.text ?? ""
        let next = appending ? current + text : text
        let range = appending
            ? NSRange(location: (current as NSString).length, length: 0)
            : NSRange(location: 0, length: (current as NSString).length)

        if textView.delegate?.textView?(textView, shouldChangeTextIn: range, replacementText: text) == false {
            throw LookDebugActionExecutorError.unsupportedElementType
        }

        textView.becomeFirstResponder()
        textView.text = next
        textView.accessibilityValue = next.isEmpty ? nil : next
        textView.delegate?.textViewDidChange?(textView)
        NotificationCenter.default.post(name: UITextView.textDidChangeNotification, object: textView)
        return next
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
