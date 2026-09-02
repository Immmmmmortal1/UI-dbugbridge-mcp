Pod::Spec.new do |s|
  s.name = "LookDebugBridge"
  s.version = "0.1.16"
  s.summary = "A debug-only HTTP bridge for AI-driven iOS UI inspection, control, and logs."
  s.description = <<-DESC
    LookDebugBridge exposes stable debug element actions, UIWindow hierarchy inspection,
    and temporary in-memory App logs through a local HTTP bridge.
  DESC
  s.homepage = "https://github.com/Immmmmmortal1/LookDebugBridgeService"
  s.license = { :type => "MIT", :file => "LICENSE" }
  s.author = { "Shuxia" => "opensource@shuxia.local" }
  s.source = { :git => "https://github.com/Immmmmmortal1/LookDebugBridgeService.git", :tag => s.version.to_s }

  s.ios.deployment_target = "14.0"
  s.swift_versions = ["5.0"]
  s.source_files = "Sources/LookDebugBridge/**/*.swift"
  s.frameworks = ["UIKit", "Network"]
end
