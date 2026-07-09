Pod::Spec.new do |s|
  s.name = "LookDebugBridge"
  s.version = "0.1.0"
  s.summary = "A debug-only HTTP action bridge for AI-driven iOS UI inspection and control."
  s.description = <<-DESC
    LookDebugBridge pairs with LookinServer and lookdebug-mcp. LookinServer is used
    for UI hierarchy inspection, while LookDebugBridge exposes stable debug element
    actions such as tap and switch control through a local HTTP bridge.
  DESC
  s.homepage = "https://github.com/Immmmmmortal1/ui_lookin_debugbridge"
  s.license = { :type => "MIT", :file => "LICENSE" }
  s.author = { "Shuxia" => "opensource@shuxia.local" }
  s.source = { :git => "https://github.com/Immmmmmortal1/ui_lookin_debugbridge.git", :tag => s.version.to_s }

  s.ios.deployment_target = "14.0"
  s.swift_versions = ["5.0"]
  s.source_files = "Sources/LookDebugBridge/**/*.swift"
  s.frameworks = ["UIKit", "Network"]
  s.dependency "LookinServer/Swift"
end
