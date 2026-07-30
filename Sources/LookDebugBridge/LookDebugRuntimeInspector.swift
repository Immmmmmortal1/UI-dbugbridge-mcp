import ObjectiveC
import UIKit

@MainActor
struct LookDebugRuntimeInspector {
    func node(anchor: String) -> LookDebugRuntimeNodeResponse {
        let matches = matchingViews(anchor: anchor)

        return LookDebugRuntimeNodeResponse(
            anchor: anchor,
            found: !matches.isEmpty,
            unique: matches.count == 1,
            matchCount: matches.count,
            node: matches.count == 1 ? detail(for: matches[0], anchor: anchor) : nil,
            matches: matches.map { summary(for: $0) },
            error: matches.isEmpty ? "node_not_found" : (matches.count == 1 ? nil : "node_not_unique")
        )
    }

    private func matchingViews(anchor: String) -> [UIView] {
        var results: [UIView] = []

        for window in activeWindows() {
            walk(window) { view in
                if view.accessibilityIdentifier == anchor {
                    results.append(view)
                }
            }
        }

        return results
    }

    private func activeWindows() -> [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .sorted { lhs, rhs in
                if lhs.isKeyWindow != rhs.isKeyWindow {
                    return lhs.isKeyWindow && !rhs.isKeyWindow
                }
                return lhs.windowLevel.rawValue < rhs.windowLevel.rawValue
            }
    }

    private func walk(_ view: UIView, visit: (UIView) -> Void) {
        visit(view)
        for subview in view.subviews {
            walk(subview, visit: visit)
        }
    }

    private func detail(for view: UIView, anchor: String) -> LookDebugRuntimeNodeDetail {
        let layer = view.layer
        let label = view as? UILabel
        let textField = view as? UITextField
        let textView = view as? UITextView
        let imageView = view as? UIImageView
        let control = view as? UIControl

        return LookDebugRuntimeNodeDetail(
            anchor: anchor,
            accessibilityIdentifier: view.accessibilityIdentifier,
            accessibilityLabel: view.accessibilityLabel,
            accessibilityValue: view.accessibilityValue,
            className: String(describing: type(of: view)),
            classChain: classChain(for: view),
            frameInWindow: rectPayload(view.convert(view.bounds, to: nil)),
            bounds: rectPayload(view.bounds),
            hidden: view.isHidden,
            alpha: Double(view.alpha),
            userInteractionEnabled: view.isUserInteractionEnabled,
            backgroundColor: colorPayload(view.backgroundColor),
            tintColor: colorPayload(view.tintColor),
            contentMode: String(describing: view.contentMode),
            cornerRadius: Double(layer.cornerRadius),
            masksToBounds: layer.masksToBounds,
            borderWidth: Double(layer.borderWidth),
            borderColor: colorPayload(layer.borderColor.map { UIColor(cgColor: $0) }),
            shadowColor: colorPayload(layer.shadowColor.map { UIColor(cgColor: $0) }),
            shadowOpacity: Double(layer.shadowOpacity),
            shadowRadius: Double(layer.shadowRadius),
            shadowOffset: sizePayload(layer.shadowOffset),
            text: label?.text ?? textField?.text ?? textView?.text,
            placeholder: textField?.placeholder,
            fontName: label?.font.fontName ?? textField?.font?.fontName ?? textView?.font?.fontName,
            fontSize: (label?.font.pointSize ?? textField?.font?.pointSize ?? textView?.font?.pointSize).map(Double.init),
            textColor: colorPayload(label?.textColor ?? textField?.textColor ?? textView?.textColor),
            textAlignment: textAlignmentName(label?.textAlignment ?? textField?.textAlignment ?? textView?.textAlignment),
            numberOfLines: label?.numberOfLines,
            imageAssetName: imageView?.lookDebugAssetName,
            imageSize: imageView?.image.map { sizePayload($0.size) },
            imageRenderingMode: imageView?.image.map { imageRenderingModeName($0.renderingMode) },
            controlEnabled: control?.isEnabled,
            controlSelected: control?.isSelected,
            controlHighlighted: control?.isHighlighted
        )
    }

    private func summary(for view: UIView) -> LookDebugRuntimeNodeSummary {
        LookDebugRuntimeNodeSummary(
            accessibilityIdentifier: view.accessibilityIdentifier,
            accessibilityLabel: view.accessibilityLabel,
            className: String(describing: type(of: view)),
            frameInWindow: rectPayload(view.convert(view.bounds, to: nil)),
            hidden: view.isHidden,
            alpha: Double(view.alpha)
        )
    }

    private func classChain(for object: NSObject) -> [String] {
        var chain: [String] = []
        var current: AnyClass? = type(of: object)

        while let klass = current {
            chain.append(NSStringFromClass(klass))
            current = class_getSuperclass(klass)
        }

        return chain
    }

    private func rectPayload(_ rect: CGRect) -> LookDebugRuntimeRect {
        LookDebugRuntimeRect(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.size.width),
            height: Double(rect.size.height)
        )
    }

    private func sizePayload(_ size: CGSize) -> LookDebugRuntimeSize {
        LookDebugRuntimeSize(width: Double(size.width), height: Double(size.height))
    }

    private func colorPayload(_ color: UIColor?) -> LookDebugRuntimeColor? {
        guard let color else { return nil }

        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0

        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return nil
        }

        return LookDebugRuntimeColor(
            red: Double(red),
            green: Double(green),
            blue: Double(blue),
            alpha: Double(alpha),
            hex: String(
                format: "#%02X%02X%02X%02X",
                Int(round(red * 255)),
                Int(round(green * 255)),
                Int(round(blue * 255)),
                Int(round(alpha * 255))
            )
        )
    }

    private func textAlignmentName(_ alignment: NSTextAlignment?) -> String? {
        guard let alignment else { return nil }
        switch alignment {
        case .left: return "left"
        case .center: return "center"
        case .right: return "right"
        case .justified: return "justified"
        case .natural: return "natural"
        @unknown default: return "unknown"
        }
    }

    private func imageRenderingModeName(_ mode: UIImage.RenderingMode) -> String {
        switch mode {
        case .automatic: return "automatic"
        case .alwaysOriginal: return "alwaysOriginal"
        case .alwaysTemplate: return "alwaysTemplate"
        @unknown default: return "unknown"
        }
    }
}

private var lookDebugAssetNameKey: UInt8 = 0

public extension UIImageView {
    var lookDebugAssetName: String? {
        get {
            objc_getAssociatedObject(self, &lookDebugAssetNameKey) as? String
        }
        set {
            objc_setAssociatedObject(
                self,
                &lookDebugAssetNameKey,
                newValue,
                .OBJC_ASSOCIATION_COPY_NONATOMIC
            )
        }
    }
}
