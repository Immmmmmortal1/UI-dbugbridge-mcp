import Foundation

public enum LookDebugElementType: String, Codable, Equatable {
    case button
    case `switch` = "switch"
    case cell
    case text
    case label
    case view
}

struct LookDebugElementMetadata: Codable, Equatable {
    let id: String
    let type: LookDebugElementType
    let label: String
    let enabled: Bool
}

struct LookDebugPagePayload: Codable, Equatable {
    let pageID: String
    let title: String
    let elements: [LookDebugElementMetadata]
}

struct LookDebugPingResponse: Codable, Equatable {
    let ok: Bool
}

struct LookDebugTapRequest: Codable, Equatable {
    let id: String
}

struct LookDebugTapResponse: Codable, Equatable {
    let success: Bool
    let id: String?
    let error: String?
}

struct LookDebugSwitchRequest: Codable, Equatable {
    let id: String
    let isOn: Bool
}

struct LookDebugSwitchResponse: Codable, Equatable {
    let success: Bool
    let id: String?
    let isOn: Bool?
    let error: String?
}

struct LookDebugTextRequest: Codable, Equatable {
    let id: String
    let text: String
}

struct LookDebugTextResponse: Codable, Equatable {
    let success: Bool
    let id: String?
    let text: String?
    let error: String?
}

struct LookDebugRuntimeNodeRequest: Codable, Equatable {
    let anchor: String
}

struct LookDebugRuntimeRect: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct LookDebugRuntimeSize: Codable, Equatable {
    let width: Double
    let height: Double
}

struct LookDebugRuntimeColor: Codable, Equatable {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double
    let hex: String
}

struct LookDebugRuntimeNodeSummary: Codable, Equatable {
    let accessibilityIdentifier: String?
    let accessibilityLabel: String?
    let className: String
    let frameInWindow: LookDebugRuntimeRect
    let hidden: Bool
    let alpha: Double
}

struct LookDebugRuntimeNodeDetail: Codable, Equatable {
    let anchor: String
    let accessibilityIdentifier: String?
    let accessibilityLabel: String?
    let accessibilityValue: String?
    let className: String
    let classChain: [String]
    let frameInWindow: LookDebugRuntimeRect
    let bounds: LookDebugRuntimeRect
    let hidden: Bool
    let alpha: Double
    let userInteractionEnabled: Bool
    let backgroundColor: LookDebugRuntimeColor?
    let tintColor: LookDebugRuntimeColor?
    let contentMode: String
    let cornerRadius: Double
    let masksToBounds: Bool
    let borderWidth: Double
    let borderColor: LookDebugRuntimeColor?
    let shadowColor: LookDebugRuntimeColor?
    let shadowOpacity: Double
    let shadowRadius: Double
    let shadowOffset: LookDebugRuntimeSize
    let text: String?
    let placeholder: String?
    let fontName: String?
    let fontSize: Double?
    let textColor: LookDebugRuntimeColor?
    let textAlignment: String?
    let numberOfLines: Int?
    let imageAssetName: String?
    let imageSize: LookDebugRuntimeSize?
    let imageRenderingMode: String?
    let controlEnabled: Bool?
    let controlSelected: Bool?
    let controlHighlighted: Bool?
}

struct LookDebugRuntimeNodeResponse: Codable, Equatable {
    let anchor: String
    let found: Bool
    let unique: Bool
    let matchCount: Int
    let node: LookDebugRuntimeNodeDetail?
    let matches: [LookDebugRuntimeNodeSummary]
    let error: String?
}

struct LookDebugWindowTreeNode: Codable, Equatable {
    let className: String
    let accessibilityIdentifier: String?
    let accessibilityLabel: String?
    let accessibilityValue: String?
    let frameInWindow: LookDebugRuntimeRect
    let hidden: Bool
    let alpha: Double
    let userInteractionEnabled: Bool
    let text: String?
    let children: [LookDebugWindowTreeNode]
}

struct LookDebugWindowTree: Codable, Equatable {
    let className: String
    let isKeyWindow: Bool
    let windowLevel: Double
    let hidden: Bool
    let frameInWindow: LookDebugRuntimeRect
    let root: LookDebugWindowTreeNode?
}

struct LookDebugWindowTreeResponse: Codable, Equatable {
    let success: Bool
    let windows: [LookDebugWindowTree]
    let truncated: Bool
    let error: String?
}

struct LookDebugErrorResponse: Codable, Equatable {
    let success: Bool
    let error: String
}

struct LookDebugHTTPResponse: Equatable {
    let statusCode: Int
    let body: Data
}
