import UIKit

@MainActor
public final class LookDebugElementRegistry {
    @MainActor
    final class Entry {
        weak var view: UIView?

        private let id: String
        private let type: LookDebugElementType
        private let label: String
        private let tapAction: (() -> Void)?

        init(view: UIView, id: String, type: LookDebugElementType, label: String, tapAction: (() -> Void)?) {
            self.view = view
            self.id = id
            self.type = type
            self.label = label
            self.tapAction = tapAction
        }

        var metadata: LookDebugElementMetadata {
            LookDebugElementMetadata(
                id: id,
                type: type,
                label: label,
                enabled: currentEnabled
            )
        }

        var hasTapAction: Bool {
            tapAction != nil
        }

        func performTapActionIfAvailable() -> Bool {
            guard let tapAction else { return false }
            tapAction()
            return true
        }

        private var currentEnabled: Bool {
            if let control = view as? UIControl {
                return control.isEnabled
            }
            return view?.isUserInteractionEnabled ?? false
        }
    }

    private var entries: [String: Entry] = [:]

    public func register(
        view: UIView,
        id: String,
        type: LookDebugElementType,
        label: String,
        tapAction: (() -> Void)? = nil
    ) {
        entries[id] = Entry(view: view, id: id, type: type, label: label, tapAction: tapAction)
    }

    func entry(for id: String) -> Entry? {
        guard let entry = entries[id] else {
            return nil
        }

        guard entry.view != nil else {
            entries[id] = nil
            return nil
        }

        return entry
    }

    var allMetadata: [LookDebugElementMetadata] {
        removeReleasedEntries()
        return entries.values.map(\.metadata).sorted { $0.id < $1.id }
    }

    func removeReleasedEntries() {
        entries = entries.filter { $0.value.view != nil }
    }
}
