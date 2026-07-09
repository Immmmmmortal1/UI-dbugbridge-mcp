import UIKit

@MainActor
public protocol LookDebugPageDescribing: AnyObject {
    var lookDebugPageID: String { get }
    var lookDebugPageTitle: String { get }

    func registerLookDebugElements(in registry: LookDebugElementRegistry)
}
