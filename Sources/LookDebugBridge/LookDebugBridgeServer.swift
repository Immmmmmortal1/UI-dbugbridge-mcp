import Foundation
import Network
import UIKit

typealias LookDebugCurrentViewControllerProvider = @MainActor () -> UIViewController?

final class LookDebugBridgeServer {
    /// 监听器对外状态（idle/starting/ready/failed/cancelled）
    enum State: Equatable {
        case idle
        case starting
        case ready
        case failed
        case cancelled
    }

    private let port: UInt16
    private let router: LookDebugBridgeRouter
    /// 可选鉴权 token：配置后所有接口需校验请求头 X-LookDebug-Token
    private let token: String?
    private let queue = DispatchQueue(label: "com.shuxia.lookdebug.bridge")
    private var listener: NWListener?
    private var stateHandler: ((State) -> Void)?
    /// 当前监听端口（只读暴露，供 /debug/identity 等只读接口回读）
    var activePort: UInt16 { port }
    /// listener 是否已进入终态（failed/cancelled），幂等去重避免 failed→cancelled 竞态覆盖
    /// 仅在 queue 线程（handleListenerState）读写，避免跨线程竞争
    private var reachedTerminalState = false

    @MainActor
    init(port: UInt16 = 37777, router: LookDebugBridgeRouter? = nil, token: String? = nil) {
        self.port = port
        self.router = router ?? LookDebugBridgeRouter()
        self.token = token
    }

    func start(
        currentViewControllerProvider: @escaping LookDebugCurrentViewControllerProvider,
        onStateChange: ((State) -> Void)? = nil
    ) throws {
        guard listener == nil else { return }

        self.stateHandler = onStateChange
        // 重置终态标记（在 listener.start 之前同步执行，建立 happens-before 到 queue 上的 handler）
        reachedTerminalState = false
        onStateChange?(.starting)

        let parameters = NWParameters.tcp
        // iOS 26 真机修复：避免端口 TIME_WAIT 导致 NWListener 启动失败，保留 reuse
        // 注意：不要改 requiredLocalEndpoint，隧道连接来自设备 utun 接口不是回环
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection, currentViewControllerProvider: currentViewControllerProvider)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.handleListenerState(state)
        }
        listener.start(queue: queue)
        self.listener = listener
        LookDebugBridge.log("listening on \(port)", category: "bridge")
    }

    private func handleListenerState(_ state: NWListener.State) {
        #if DEBUG
        print("[LookDebugBridge] listener state: \(state)")
        #endif
        switch state {
        case .ready:
            // ready 不是终态，listener 仍可能后续 failed；直接上报
            notifyState(.ready)
        case .failed(let error):
            // 幂等去重：已进入终态则忽略（避免 failed 后 cancel 触发的 cancelled 覆盖 failed 状态）
            guard !reachedTerminalState else { return }
            reachedTerminalState = true
            LookDebugBridge.log("server failed: \(error)", level: "error", category: "bridge")
            // 失败时清理 listener；cancel() 会再触发 .cancelled，但已被 reachedTerminalState 拦截
            listener?.cancel()
            self.listener = nil
            notifyState(.failed)
        case .cancelled:
            // 幂等去重：failed 引起的 cancelled 会被拦截，仅处理非 failed 引起的主动 cancel
            guard !reachedTerminalState else { return }
            reachedTerminalState = true
            self.listener = nil
            notifyState(.cancelled)
        default:
            break
        }
    }

    /// 状态上报：通过 Task @MainActor 投递到主线程，queue 线程不直接调上层 @MainActor 闭包
    private func notifyState(_ state: State) {
        Task { @MainActor [weak self] in
            self?.stateHandler?(state)
        }
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

        // 检查 Content-Length 是否非法 / 超限（header 已完整时立即响应，不继续 receive）
        switch expectedHTTPRequestLength(accumulated) {
        case .length(let expected) where accumulated.count >= expected:
            // 完整请求 → 路由
            Task { @MainActor in
                let response = await self.route(data: accumulated, currentViewControllerProvider: currentViewControllerProvider)
                self.send(response: response, on: connection)
            }
            return
        case .invalid:
            // Content-Length 非法（非数字/负数/溢出）→ 400
            Task { @MainActor in
                let response = (try? self.errorResponse(statusCode: 400, error: "bad_request"))
                    ?? LookDebugHTTPResponse(statusCode: 400, body: Data())
                self.send(response: response, on: connection)
            }
            return
        case .tooLarge:
            // Content-Length 超限 → 413
            Task { @MainActor in
                let response = (try? self.errorResponse(statusCode: 413, error: "request_too_large"))
                    ?? LookDebugHTTPResponse(statusCode: 413, body: Data())
                self.send(response: response, on: connection)
            }
            return
        case .length, .waiting:
            // 尚未完整，继续接收
            break
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
        // 1. HTTP 解析错误：Content-Length 超限 → 413；其他解析错误 → 400
        let request: ParsedLookDebugHTTPRequest
        do {
            request = try ParsedLookDebugHTTPRequest(data: data)
        } catch ParsedLookDebugHTTPRequest.ParseError.contentLengthTooLarge {
            return (try? errorResponse(statusCode: 413, error: "request_too_large"))
                ?? LookDebugHTTPResponse(statusCode: 413, body: Data())
        } catch {
            return (try? errorResponse(statusCode: 400, error: "bad_request"))
                ?? LookDebugHTTPResponse(statusCode: 400, body: Data())
        }

        // 2. Token 鉴权：配置 token 时所有接口校验 X-LookDebug-Token
        if let token, !token.isEmpty {
            if request.headerValue("X-LookDebug-Token") != token {
                return (try? errorResponse(statusCode: 401, error: "unauthorized"))
                    ?? LookDebugHTTPResponse(statusCode: 401, body: Data())
            }
        }

        // 3. 路由分发：JSON 解码错误 → 400；未知路由 → 404；动作失败 → 500
        do {
            switch (request.method, request.path) {
            case ("GET", "/ping"):
                return try router.ping()
            case ("GET", "/debug/identity"):
                // 只读 identity：返回 bundleID / sessionID / port，用于 Mac 侧 preflight 校验目标 App
                // sessionID 是上下文标记（POST /debug/session 注入），不作为并发隔离依据
                return try router.identity()
            case ("GET", "/debug/logs"):
                return try await router.logs(
                    query: request.queryValue("query"),
                    level: request.queryValue("level"),
                    category: request.queryValue("category"),
                    limit: request.queryInt("limit", default: LookDebugLogStore.defaultReadLimit),
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
            case ("POST", "/debug/session"):
                // 运行时注入会话 ID（修复真机 devicectl launch 无法注入环境变量导致 sessionID 恒 local）
                let payload = try JSONDecoder().decode(LookDebugSessionRequest.self, from: request.body)
                return try router.setSession(request: payload)
            default:
                return try errorResponse(statusCode: 404, error: "not_found")
            }
        } catch is DecodingError {
            // JSON 解码错误 → 400
            return (try? errorResponse(statusCode: 400, error: "invalid_json"))
                ?? LookDebugHTTPResponse(statusCode: 400, body: Data())
        } catch {
            // 动作执行失败 → 500
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
        switch expectedHTTPRequestLength(data) {
        case .length(let expected):
            return data.count >= expected
        case .waiting, .invalid, .tooLarge:
            // 未完整 / 非法 / 超限 都不算"完整请求"（非法/超限由 receiveRequest 单独处理）
            return false
        }
    }

    /// 解析期望的完整请求长度，区分三种异常情况：
    /// - `.length(Int)`：header + body 的总长度已知
    /// - `.waiting`：header 未接收完整或无 Content-Length 头，继续等待
    /// - `.invalid`：Content-Length 非法（非数字 / 负数 / 溢出），应返回 400
    /// - `.tooLarge`：Content-Length 超过 maxBodyLength，应返回 413
    private func expectedHTTPRequestLength(_ data: Data) -> ExpectedLengthResult {
        let delimiter = Data("\r\n\r\n".utf8)
        guard let headerRange = data.range(of: delimiter),
              let head = String(data: data[..<headerRange.lowerBound], encoding: .utf8) else {
            return .waiting // header 未接收完整
        }

        // 查找 Content-Length 头（大小写不敏感）
        let contentLengthLine = head
            .components(separatedBy: "\r\n")
            .first { line in
                let parts = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                return parts.count == 2
                    && parts[0].caseInsensitiveCompare("Content-Length") == .orderedSame
            }

        // 无 Content-Length 头 → 按 0 处理（保持兼容，body 为空）
        guard let line = contentLengthLine else {
            return .length(headerRange.upperBound)
        }

        let rawValue = line.split(separator: ":", maxSplits: 1)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }[1]

        // 有 Content-Length 头但值非法（非数字 / 超大整数溢出）→ 400，不能回退 0
        guard let parsed = Int(rawValue) else {
            return .invalid
        }
        // 负数 → 400
        guard parsed >= 0 else {
            return .invalid
        }
        // 超限 → 413，不能静默处理
        guard parsed <= LookDebugHTTPConstants.maxBodyLength else {
            return .tooLarge
        }

        let bodyStart = headerRange.upperBound
        let (sum, overflow) = bodyStart.addingReportingOverflow(parsed)
        if overflow { return .invalid }
        return .length(sum)
    }

    /// HTTP 请求长度解析结果
    private enum ExpectedLengthResult {
        case length(Int)
        case waiting
        case invalid
        case tooLarge
    }

    private func reasonPhrase(for statusCode: Int) -> String {
        switch statusCode {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Internal Server Error"
        }
    }
}
private struct ParsedLookDebugHTTPRequest {
    let method: String
    let path: String
    let queryItems: [URLQueryItem]
    /// 请求头（key 已小写，便于大小写不敏感查找）
    let headers: [String: String]
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

        // 解析请求头（key 小写化，便于大小写不敏感查找）
        var lowerHeaders: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colonIndex = line.firstIndex(of: ":") else { continue }
            let name = String(line[..<colonIndex])
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let value = String(line[line.index(after: colonIndex)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                lowerHeaders[name] = value
            }
        }
        headers = lowerHeaders

        // Content-Length 解析与溢出保护：
        // - 无 Content-Length 头 → 按 0 处理（保持兼容，body 为空）
        // - 有该头但值非法（非数字/超大整数溢出）→ invalidContentLength（400）
        // - 负数 → invalidContentLength（400）
        // - 超限 → contentLengthTooLarge（413）
        let contentLength: Int
        if let raw = lowerHeaders["content-length"] {
            guard let parsed = Int(raw) else {
                throw ParseError.invalidContentLength
            }
            guard parsed >= 0 else {
                throw ParseError.invalidContentLength
            }
            guard parsed <= LookDebugHTTPConstants.maxBodyLength else {
                throw ParseError.contentLengthTooLarge
            }
            contentLength = parsed
        } else {
            contentLength = 0
        }

        let bodyStart = headerRange.upperBound
        let (bodyEnd, overflow) = bodyStart.addingReportingOverflow(contentLength)
        if overflow || bodyEnd > data.count {
            // body 未接收完整或溢出 → malformed
            throw ParseError.malformedRequest
        }
        body = data.subdata(in: bodyStart..<bodyEnd)
    }

    enum ParseError: Error {
        case invalidEncoding
        case malformedRequest
        case invalidContentLength
        case contentLengthTooLarge
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

    /// 大小写不敏感读取请求头
    func headerValue(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

/// HTTP 解析相关常量
private enum LookDebugHTTPConstants {
    /// 单请求 body 最大长度（1 MiB），与 receiveRequest 中的 1_048_576 上限保持一致
    static let maxBodyLength = 1_048_576
}
