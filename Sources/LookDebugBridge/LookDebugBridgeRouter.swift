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

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                Task { @MainActor in
                    try? executor.tap(id: request.id)
                }
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
            let finalText = try executor.setText(id: request.id, text: request.text, appending: appending)

            return try jsonResponse(
                statusCode: 200,
                payload: LookDebugTextResponse(
                    success: true,
                    id: request.id,
                    text: finalText,
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

    private func jsonResponse<T: Encodable>(statusCode: Int, payload: T) throws -> LookDebugHTTPResponse {
        let data = try JSONEncoder().encode(payload)
        return LookDebugHTTPResponse(statusCode: statusCode, body: data)
    }
}
