import Foundation
import Network
import UIKit

typealias LookDebugCurrentViewControllerProvider = @MainActor () -> UIViewController?

final class LookDebugBridgeServer {
    private var port: UInt16
    private let router: LookDebugBridgeRouter
    private let queue = DispatchQueue(label: "com.shuxia.lookdebug.bridge")
    private var listener: NWListener?

    var activePort: UInt16 { port }

    @MainActor
    init(port: UInt16, router: LookDebugBridgeRouter? = nil) {
        self.port = port
        self.router = router ?? LookDebugBridgeRouter()
    }

    func start(currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider) throws {
        guard listener == nil else { return }

        startListener(currentViewControllerProvider: currentViewControllerProvider, port: port)
    }

    private func startListener(
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider,
        port: UInt16
    ) {
        let parameters = NWParameters.tcp
        guard let endpointPort = NWEndpoint.Port(rawValue: port),
              let listener = try? NWListener(using: parameters, on: endpointPort) else {
            retryNextPort(currentViewControllerProvider: currentViewControllerProvider, after: port)
            return
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection, currentViewControllerProvider: currentViewControllerProvider)
        }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                self.port = port
                LookDebugBridge.log("listening on \(port)", category: "bridge")
            case let .failed(error):
                self.listener = nil
                LookDebugBridge.log("server failed on \(port): \(error)", level: "error", category: "bridge")
                self.retryNextPort(currentViewControllerProvider: currentViewControllerProvider, after: port)
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func retryNextPort(
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider,
        after port: UInt16
    ) {
        guard let nextPort = LookDebugPort.next(after: port) else {
            LookDebugBridge.log("no available bridge port in \(LookDebugPort.firstDynamicPort)-\(LookDebugPort.lastDynamicPort)", level: "error", category: "bridge")
            return
        }
        startListener(currentViewControllerProvider: currentViewControllerProvider, port: nextPort)
    }

    private func handle(
        connection: NWConnection,
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider
    ) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, error in
            guard let self else { return }

            if let error {
                LookDebugBridge.log("receive error: \(error)", level: "error", category: "bridge")
                connection.cancel()
                return
            }

            guard let data, !data.isEmpty else {
                connection.cancel()
                return
            }

            self.receiveRequest(
                on: connection,
                accumulated: data,
                currentViewControllerProvider: currentViewControllerProvider
            )
        }
    }

    private func receiveRequest(
        on connection: NWConnection,
        accumulated: Data,
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider
    ) {
        if accumulated.count > 1_048_576 {
            Task { @MainActor in
                let response = (try? self.errorResponse(statusCode: 413, error: "request_too_large"))
                    ?? LookDebugHTTPResponse(statusCode: 413, body: Data())
                self.send(response: response, on: connection)
            }
            return
        }

        if isCompleteHTTPRequest(accumulated) {
            Task { @MainActor in
                let response = await self.route(data: accumulated, currentViewControllerProvider: currentViewControllerProvider)
                self.send(response: response, on: connection)
            }
            return
        }

        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let error {
                LookDebugBridge.log("receive error: \(error)", level: "error", category: "bridge")
                connection.cancel()
                return
            }

            var next = accumulated
            if let data {
                next.append(data)
            }

            if isComplete && !self.isCompleteHTTPRequest(next) {
                Task { @MainActor in
                    let response = (try? self.errorResponse(statusCode: 400, error: "malformed_request"))
                        ?? LookDebugHTTPResponse(statusCode: 400, body: Data())
                    self.send(response: response, on: connection)
                }
                return
            }

            self.receiveRequest(
                on: connection,
                accumulated: next,
                currentViewControllerProvider: currentViewControllerProvider
            )
        }
    }

    @MainActor
    private func route(
        data: Data,
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider
    ) async -> LookDebugHTTPResponse {
        do {
            let request = try ParsedLookDebugHTTPRequest(data: data)

            switch (request.method, request.path) {
            case ("GET", "/ping"):
                return try router.ping()
            case ("GET", "/debug/identity"):
                return try router.identity()
            case ("GET", "/debug/logs"):
                return try await router.logs(
                    query: request.queryValue("query"),
                    level: request.queryValue("level"),
                    category: request.queryValue("category"),
                    limit: request.queryInt("limit", default: 500),
                    waitMs: request.queryInt("wait_ms", default: 0)
                )
            case ("GET", "/debug/windows"):
                return try router.windows(
                    depth: request.queryInt("depth", default: 8),
                    includeHidden: request.queryBool("include_hidden", default: false),
                    maxNodes: request.queryInt("max_nodes", default: 2_000)
                )
            case ("GET", "/debug/page"):
                return try router.page(currentViewController: currentViewControllerProvider())
            case ("POST", "/debug/tap"):
                let payload = try JSONDecoder().decode(LookDebugTapRequest.self, from: request.body)
                return try router.tap(
                    request: payload,
                    currentViewController: currentViewControllerProvider()
                )
            case ("POST", "/debug/switch"):
                let payload = try JSONDecoder().decode(LookDebugSwitchRequest.self, from: request.body)
                return try router.setSwitch(
                    request: payload,
                    currentViewController: currentViewControllerProvider()
                )
            case ("POST", "/debug/text/set"):
                let payload = try JSONDecoder().decode(LookDebugTextRequest.self, from: request.body)
                return try router.setText(
                    request: payload,
                    appending: false,
                    currentViewController: currentViewControllerProvider()
                )
            case ("POST", "/debug/text/type"):
                let payload = try JSONDecoder().decode(LookDebugTextRequest.self, from: request.body)
                return try router.setText(
                    request: payload,
                    appending: true,
                    currentViewController: currentViewControllerProvider()
                )
            case ("POST", "/debug/runtime/node"):
                let payload = try JSONDecoder().decode(LookDebugRuntimeNodeRequest.self, from: request.body)
                return try router.runtimeNode(request: payload)
            default:
                return try errorResponse(statusCode: 404, error: "not_found")
            }
        } catch {
            return (try? errorResponse(statusCode: 500, error: "action_failed"))
                ?? LookDebugHTTPResponse(statusCode: 500, body: Data())
        }
    }

    private func send(response: LookDebugHTTPResponse, on connection: NWConnection) {
        let header = """
        HTTP/1.1 \(response.statusCode) \(reasonPhrase(for: response.statusCode))\r
        Content-Type: application/json\r
        Content-Length: \(response.body.count)\r
        Connection: close\r
        \r

        """
        var payload = Data(header.utf8)
        payload.append(response.body)

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func errorResponse(statusCode: Int, error: String) throws -> LookDebugHTTPResponse {
        let body = try JSONEncoder().encode(LookDebugErrorResponse(success: false, error: error))
        return LookDebugHTTPResponse(statusCode: statusCode, body: body)
    }

    private func isCompleteHTTPRequest(_ data: Data) -> Bool {
        guard let expectedLength = expectedHTTPRequestLength(data) else {
            return false
        }
        return data.count >= expectedLength
    }

    private func expectedHTTPRequestLength(_ data: Data) -> Int? {
        let delimiter = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: delimiter),
              let head = String(data: data[..<headerRange.lowerBound], encoding: .utf8) else {
            return nil
        }

        let contentLength = head
            .components(separatedBy: "\r\n")
            .compactMap { line -> Int? in
                let parts = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                guard parts.count == 2,
                      parts[0].caseInsensitiveCompare("Content-Length") == .orderedSame else {
                    return nil
                }
                return Int(parts[1])
            }
            .first ?? 0

        return headerRange.upperBound + contentLength
    }

    private func reasonPhrase(for statusCode: Int) -> String {
        switch statusCode {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 503: return "Service Unavailable"
        default: return "Internal Server Error"
        }
    }
}

private struct ParsedLookDebugHTTPRequest {
    let method: String
    let path: String
    let queryItems: [URLQueryItem]
    let body: Data

    init(data: Data) throws {
        guard String(data: data, encoding: .utf8) != nil else {
            throw ParseError.invalidEncoding
        }

        let delimiter = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: delimiter),
              let head = String(data: data[..<headerRange.lowerBound], encoding: .utf8) else {
            throw ParseError.malformedRequest
        }
        let lines = head.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            throw ParseError.malformedRequest
        }

        let tokens = requestLine.split(separator: " ")
        guard tokens.count >= 2 else {
            throw ParseError.malformedRequest
        }

        method = String(tokens[0])
        let rawPath = String(tokens[1])
        guard let components = URLComponents(string: "http://localhost\(rawPath)"),
              let parsedPath = components.path.isEmpty ? nil : components.path else {
            throw ParseError.malformedRequest
        }
        path = parsedPath
        queryItems = components.queryItems ?? []
        let contentLength = lines
            .compactMap { line -> Int? in
                let parts = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                guard parts.count == 2,
                      parts[0].caseInsensitiveCompare("Content-Length") == .orderedSame else {
                    return nil
                }
                return Int(parts[1])
            }
            .first ?? 0
        let bodyStart = headerRange.upperBound
        let bodyEnd = min(data.count, bodyStart + contentLength)
        body = data.subdata(in: bodyStart..<bodyEnd)
    }

    enum ParseError: Error {
        case invalidEncoding
        case malformedRequest
    }

    func queryValue(_ name: String) -> String? {
        queryItems.first { $0.name == name }?.value
    }

    func queryInt(_ name: String, default fallback: Int) -> Int {
        guard let value = queryValue(name), let parsed = Int(value) else { return fallback }
        return parsed
    }

    func queryBool(_ name: String, default fallback: Bool) -> Bool {
        guard let value = queryValue(name)?.lowercased() else { return fallback }
        if value == "1" || value == "true" || value == "yes" { return true }
        if value == "0" || value == "false" || value == "no" { return false }
        return fallback
    }
}
