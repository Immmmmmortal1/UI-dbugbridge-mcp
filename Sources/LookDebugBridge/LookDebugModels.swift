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

struct LookDebugErrorResponse: Codable, Equatable {
    let success: Bool
    let error: String
}

struct LookDebugHTTPResponse: Equatable {
    let statusCode: Int
    let body: Data
}
