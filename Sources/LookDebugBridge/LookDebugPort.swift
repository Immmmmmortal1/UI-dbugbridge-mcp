import Foundation

enum LookDebugPort {
    static let firstDynamicPort: UInt16 = 42_671
    static let lastDynamicPort: UInt16 = 42_770

    static func resolve() -> UInt16 {
        let environment = ProcessInfo.processInfo.environment
        for key in ["BRIDGE_REMOTE_PORT", "LOOKDEBUG_BRIDGE_PORT"] {
            if let value = environment[key],
               let port = UInt32(value),
               (1...65_535).contains(port) {
                return UInt16(port)
            }
        }

        return firstDynamicPort
    }

    static func next(after port: UInt16) -> UInt16? {
        guard port < lastDynamicPort else { return nil }
        return port + 1
    }
}
