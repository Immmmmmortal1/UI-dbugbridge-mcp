import Foundation
import Network
import UIKit

typealias LookDebugCurrentViewControllerProvider = @MainActor () -> UIViewController?

final class LookDebugBridgeServer {
    private let port: UInt16
    private let router: LookDebugBridgeRouter
    private let queue = DispatchQueue(label: "com.shuxia.lookdebug.bridge")
    private var listener: NWListener?

    @MainActor
    init(port: UInt16 = 37777, router: LookDebugBridgeRouter? = nil) {
        self.port = port
        self.router = router ?? LookDebugBridgeRouter()
    }

    func start(currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider) throws {
        guard listener == nil else { return }

        let parameters = NWParameters.tcp
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection, currentViewControllerProvider: currentViewControllerProvider)
        }
        listener.stateUpdateHandler = { state in
            if case let .failed(error) = state {
                print("LookDebugBridgeServer failed: \(error)")
            }
        }
        listener.start(queue: queue)
        self.listener = listener
        print("LookDebugBridge listening on \(port)")
    }

    private func handle(
        connection: NWConnection,
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider
    ) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, error in
            guard let self else { return }

            if let error {
                print("LookDebugBridgeServer receive error: \(error)")
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
                print("LookDebugBridgeServer receive error: \(error)")
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
    let body: Data

    init(data: Data) throws {
        guard let string = String(data: data, encoding: .utf8) else {
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
        path = String(tokens[1])
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
}
