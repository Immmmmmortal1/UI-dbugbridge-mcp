import Foundation
import UIKit

@MainActor
struct LookDebugBridgeRouter {
    private let pageProvider: LookDebugPageProvider

    init(pageProvider: LookDebugPageProvider? = nil) {
        self.pageProvider = pageProvider ?? LookDebugPageProvider()
    }

    func ping() throws -> LookDebugHTTPResponse {
        try jsonResponse(statusCode: 200, payload: LookDebugPingResponse(ok: true))
    }

    /// 只读 identity：返回 bundleID / sessionID / port
    /// - sessionID 由 POST /debug/session 运行时注入（初始为环境变量或 "local"）
    /// - sessionID 是上下文标记（用于日志/identity 匹配），不是并发隔离依据
    /// - 多个 MCP 会话并发控制同一 App 仍需后续 ownership/lease 机制
    func identity() throws -> LookDebugHTTPResponse {
        try jsonResponse(
            statusCode: 200,
            payload: LookDebugIdentityResponse(
                ok: true,
                bundleID: LookDebugBridge.bundleID,
                sessionID: LookDebugBridge.sessionID,
                port: LookDebugBridge.shared.activePort
            )
        )
    }

    func page(currentViewController: UIViewController?) throws -> LookDebugHTTPResponse {
        do {
            let payload = try pageProvider.payload(for: currentViewController)
            return try jsonResponse(statusCode: 200, payload: payload)
        } catch LookDebugPageProviderError.pageUnavailable {
            return try jsonResponse(
                statusCode: 503,
                payload: LookDebugErrorResponse(success: false, error: "page_unavailable")
            )
        }
    }

    func tap(
        request: LookDebugTapRequest,
        currentViewController: UIViewController?
    ) throws -> LookDebugHTTPResponse {
        do {
            let resolvedPage = try pageProvider.resolvedPage(for: currentViewController)
            let executor = LookDebugActionExecutor(registry: resolvedPage.registry)
            try executor.validateTappable(id: request.id)

            // 同步执行 tap，捕获真实结果（错误透传，不吞错误）
            // 原 50ms asyncAfter 会丢失 tap 失败信息，改为立即执行
            do {
                try executor.tap(id: request.id)
            } catch {
                return try jsonResponse(
                    statusCode: 500,
                    payload: LookDebugTapResponse(success: false, id: request.id, error: "tap_failed")
                )
            }

            return try jsonResponse(
                statusCode: 200,
                payload: LookDebugTapResponse(success: true, id: request.id, error: nil)
            )
        } catch LookDebugPageProviderError.pageUnavailable {
            return try jsonResponse(
                statusCode: 503,
                payload: LookDebugErrorResponse(success: false, error: "page_unavailable")
            )
        } catch LookDebugActionExecutorError.elementNotFound {
            return try jsonResponse(
                statusCode: 404,
                payload: LookDebugTapResponse(success: false, id: nil, error: "element_not_found")
            )
        } catch LookDebugActionExecutorError.unsupportedElementType {
            return try jsonResponse(
                statusCode: 409,
                payload: LookDebugTapResponse(success: false, id: nil, error: "unsupported_element_type")
            )
        } catch {
            return try jsonResponse(
                statusCode: 500,
                payload: LookDebugTapResponse(success: false, id: nil, error: "action_failed")
            )
        }
    }

    func setSwitch(
        request: LookDebugSwitchRequest,
        currentViewController: UIViewController?
    ) throws -> LookDebugHTTPResponse {
        do {
            let resolvedPage = try pageProvider.resolvedPage(for: currentViewController)
            let executor = LookDebugActionExecutor(registry: resolvedPage.registry)
            try executor.setSwitch(id: request.id, isOn: request.isOn)

            return try jsonResponse(
                statusCode: 200,
                payload: LookDebugSwitchResponse(
                    success: true,
                    id: request.id,
                    isOn: request.isOn,
                    error: nil
                )
            )
        } catch LookDebugPageProviderError.pageUnavailable {
            return try jsonResponse(
                statusCode: 503,
                payload: LookDebugErrorResponse(success: false, error: "page_unavailable")
            )
        } catch LookDebugActionExecutorError.elementNotFound {
            return try jsonResponse(
                statusCode: 404,
                payload: LookDebugSwitchResponse(success: false, id: nil, isOn: nil, error: "element_not_found")
            )
        } catch LookDebugActionExecutorError.unsupportedElementType {
            return try jsonResponse(
                statusCode: 409,
                payload: LookDebugSwitchResponse(success: false, id: nil, isOn: nil, error: "unsupported_element_type")
            )
        } catch {
            return try jsonResponse(
                statusCode: 500,
                payload: LookDebugSwitchResponse(success: false, id: nil, isOn: nil, error: "action_failed")
            )
        }
    }

    func setText(
        request: LookDebugTextRequest,
        appending: Bool,
        currentViewController: UIViewController?
    ) throws -> LookDebugHTTPResponse {
        do {
            let resolvedPage = try pageProvider.resolvedPage(for: currentViewController)
            let executor = LookDebugActionExecutor(registry: resolvedPage.registry)
            let result = try executor.setText(id: request.id, text: request.text, appending: appending)

            // secure 字段不回显明文，返回长度 + redacted=true（兼容：旧调用方忽略未知字段）
            if result.isSecure {
                return try jsonResponse(
                    statusCode: 200,
                    payload: LookDebugTextResponse(
                        success: true,
                        id: request.id,
                        text: nil,
                        error: nil,
                        length: result.finalText.count,
                        redacted: true
                    )
                )
            }

            return try jsonResponse(
                statusCode: 200,
                payload: LookDebugTextResponse(
                    success: true,
                    id: request.id,
                    text: result.finalText,
                    error: nil
                )
            )
        } catch LookDebugPageProviderError.pageUnavailable {
            return try jsonResponse(
                statusCode: 503,
                payload: LookDebugErrorResponse(success: false, error: "page_unavailable")
            )
        } catch LookDebugActionExecutorError.elementNotFound {
            return try jsonResponse(
                statusCode: 404,
                payload: LookDebugTextResponse(success: false, id: nil, text: nil, error: "element_not_found")
            )
        } catch LookDebugActionExecutorError.unsupportedElementType {
            return try jsonResponse(
                statusCode: 409,
                payload: LookDebugTextResponse(success: false, id: nil, text: nil, error: "unsupported_element_type")
            )
        } catch {
            return try jsonResponse(
                statusCode: 500,
                payload: LookDebugTextResponse(success: false, id: nil, text: nil, error: "action_failed")
            )
        }
    }

    func runtimeNode(request: LookDebugRuntimeNodeRequest) throws -> LookDebugHTTPResponse {
        let payload = LookDebugRuntimeInspector().node(anchor: request.anchor)
        let statusCode = payload.unique ? 200 : (payload.found ? 409 : 404)
        return try jsonResponse(statusCode: statusCode, payload: payload)
    }

    /// 运行时注入会话 ID：校验非空且长度 ≤ 128，非法返回 400 invalid_session_id
    /// 合法则调用 LookDebugBridge.setSessionID，返回 200 + 新 sessionID
    func setSession(request: LookDebugSessionRequest) throws -> LookDebugHTTPResponse {
        let trimmed = request.sessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128 else {
            return try jsonResponse(
                statusCode: 400,
                payload: LookDebugErrorResponse(success: false, error: "invalid_session_id")
            )
        }
        LookDebugBridge.setSessionID(trimmed)
        return try jsonResponse(
            statusCode: 200,
            payload: LookDebugSessionResponse(success: true, sessionID: trimmed)
        )
    }

    func windows(depth: Int, includeHidden: Bool, maxNodes: Int) throws -> LookDebugHTTPResponse {
        let payload = LookDebugRuntimeInspector().windowTree(
            depth: depth,
            includeHidden: includeHidden,
            maxNodes: maxNodes
        )
        return try jsonResponse(statusCode: 200, payload: payload)
    }

    func logs(
        query: String?,
        level: String?,
        category: String?,
        limit: Int,
        waitMs: Int
    ) async throws -> LookDebugHTTPResponse {
        let lines: [LookDebugLogEntry]
        let status: String
        if waitMs > 0 {
            lines = await LookDebugLogStore.shared.waitForNewEntries(
                query: query,
                level: level,
                category: category,
                limit: limit,
                timeoutMs: waitMs
            )
            status = lines.isEmpty ? "timeout" : "matched"
        } else {
            lines = await LookDebugLogStore.shared.read(
                query: query,
                level: level,
                category: category,
                limit: limit
            )
            status = lines.isEmpty ? "empty" : "matched"
        }

        let payload = LookDebugLogsResponse(
            success: true,
            sessionID: LookDebugBridge.sessionID,
            status: status,
            lines: lines,
            error: nil
        )
        return try jsonResponse(statusCode: 200, payload: payload)
    }

    /// GET /debug/logs/filter：返回当前输出过滤器
    func logsFilterGet() async throws -> LookDebugHTTPResponse {
        let current = await LookDebugLogStore.shared.currentOutputFilter()
        let payload = LookDebugLogFilterResponse(
            success: true,
            filter: current,
            active: current != nil
        )
        return try jsonResponse(statusCode: 200, payload: payload)
    }

    /// POST /debug/logs/filter：设置输出过滤器（body: {"categories": [...], "keywords": [...]}）
    func logsFilterSet(_ filter: LookDebugLogOutputFilter) async throws -> LookDebugHTTPResponse {
        await LookDebugLogStore.shared.setOutputFilter(filter)
        // 重新读真实状态：空 filter 在 store 内被 normalize 为 nil，响应要反映真实 active 状态
        let actual = await LookDebugLogStore.shared.currentOutputFilter()
        let payload = LookDebugLogFilterResponse(
            success: true,
            filter: actual,
            active: actual != nil
        )
        return try jsonResponse(statusCode: 200, payload: payload)
    }

    /// DELETE /debug/logs/filter：清除输出过滤器，恢复放行全部
    func logsFilterClear() async throws -> LookDebugHTTPResponse {
        await LookDebugLogStore.shared.clearOutputFilter()
        let payload = LookDebugLogFilterResponse(
            success: true,
            filter: nil,
            active: false
        )
        return try jsonResponse(statusCode: 200, payload: payload)
    }

    private func jsonResponse<T: Encodable>(statusCode: Int, payload: T) throws -> LookDebugHTTPResponse {
        let data = try JSONEncoder().encode(payload)
        return LookDebugHTTPResponse(statusCode: statusCode, body: data)
    }
}

/// /debug/logs/filter 响应体
struct LookDebugLogFilterResponse: Codable, Equatable {
    let success: Bool
    let filter: LookDebugLogOutputFilter?
    let active: Bool
}
