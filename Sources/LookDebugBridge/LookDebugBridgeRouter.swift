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

    private func jsonResponse<T: Encodable>(statusCode: Int, payload: T) throws -> LookDebugHTTPResponse {
        let data = try JSONEncoder().encode(payload)
        return LookDebugHTTPResponse(statusCode: statusCode, body: data)
    }
}
