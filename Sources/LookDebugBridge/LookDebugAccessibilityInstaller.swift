import ObjectiveC.runtime
import UIKit

@MainActor
enum LookDebugAccessibilityInstaller {
    private static var hasInstalled = false

    static func installIfNeeded() {
        guard !hasInstalled else { return }
        hasInstalled = true
        swizzleViewDidAppear()
    }

    private static func swizzleViewDidAppear() {
        guard let original = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.viewDidAppear(_:))),
              let replacement = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.lookDebug_viewDidAppear(_:))) else {
            return
        }
        method_exchangeImplementations(original, replacement)
    }
}
private enum LookDebugAccessibilityIdentifier {
    static func assign(for viewController: UIViewController) {
        let page = normalize(String(describing: type(of: viewController)))
        var visitedViews = Set<ObjectIdentifier>()
        assignIfNeeded(viewController.view, id: "\(page).view", visitedViews: &visitedViews)
        assignStoredViews(in: viewController, page: page, visitedViews: &visitedViews)
    }

    private static func assignStoredViews(in object: Any, page: String, visitedViews: inout Set<ObjectIdentifier>) {
        var mirror: Mirror? = Mirror(reflecting: object)
        while let currentMirror = mirror {
            for child in currentMirror.children {
                guard let label = child.label else { continue }
                assignValue(
                    child.value,
                    page: page,
                    path: [normalize(label)],
                    scanCustomViewChildren: true,
                    visitedViews: &visitedViews
                )
            }
            mirror = currentMirror.superclassMirror
        }
    }

    private static func assignValue(
        _ value: Any,
        page: String,
        path: [String],
        scanCustomViewChildren: Bool,
        visitedViews: inout Set<ObjectIdentifier>
    ) {
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            guard let child = mirror.children.first else { return }
            assignValue(
                child.value,
                page: page,
                path: path,
                scanCustomViewChildren: scanCustomViewChildren,
                visitedViews: &visitedViews
            )
            return
        }

        if let view = value as? UIView {
            let cleanedPath = sanitizedPath(path)
            assignIfNeeded(view, id: ([page] + cleanedPath).joined(separator: "."), visitedViews: &visitedViews)
            if scanCustomViewChildren {
                assignCustomStoredViews(in: view, page: page, basePath: cleanedPath, visitedViews: &visitedViews)
            }
            return
        }

        if mirror.displayStyle == .collection || mirror.displayStyle == .set {
            for (index, child) in mirror.children.enumerated() {
                assignValue(
                    child.value,
                    page: page,
                    path: path + ["item\(index)"],
                    scanCustomViewChildren: scanCustomViewChildren,
                    visitedViews: &visitedViews
                )
            }
        }
    }

    private static func assignCustomStoredViews(in view: UIView, page: String, basePath: [String], visitedViews: inout Set<ObjectIdentifier>) {
        guard isAppDefined(type: type(of: view)) else { return }

        let mirror = Mirror(reflecting: view)
        for child in mirror.children {
            guard let label = child.label else { continue }
            assignValue(
                child.value,
                page: page,
                path: basePath + [normalize(label)],
                scanCustomViewChildren: false,
                visitedViews: &visitedViews
            )
        }
    }

    private static func assignIfNeeded(_ view: UIView, id: String, visitedViews: inout Set<ObjectIdentifier>) {
        let objectID = ObjectIdentifier(view)
        guard visitedViews.insert(objectID).inserted else { return }
        if let existingID = view.accessibilityIdentifier, !existingID.isEmpty {
            let cleanedID = sanitizedID(existingID)
            if cleanedID != existingID {
                view.accessibilityIdentifier = cleanedID
            }
            return
        }
        view.accessibilityIdentifier = id
    }

    private static func isAppDefined(type: AnyClass) -> Bool {
        let name = String(reflecting: type)
        return name.contains(".") && !name.hasPrefix("UIKit.") && !name.hasPrefix("SwiftUI.")
    }

    private static func normalize(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = trimmed.unicodeScalars.map { scalar -> Character in
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

    private static func sanitizedPath(_ path: [String]) -> [String] {
        path.filter { component in
            component != "lazy" && component != "storage"
        }
    }

    private static func sanitizedID(_ id: String) -> String {
        sanitizedPath(id.split(separator: ".").map(String.init)).joined(separator: ".")
    }
}

private extension UIViewController {
    @objc func lookDebug_viewDidAppear(_ animated: Bool) {
        lookDebug_viewDidAppear(animated)
        LookDebugAccessibilityIdentifier.assign(for: self)
    }
}
