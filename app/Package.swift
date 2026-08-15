// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "UpSync",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "UpSync",
      path: "Sources/UpSync",
      // Portlanan motorla konuşan ince bir arayüz katmanı; Swift 6'nın katı
      // eşzamanlılık kontrolü burada fayda/maliyet açısından gereksiz.
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
