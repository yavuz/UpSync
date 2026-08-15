import Foundation

/// Node çalıştırılabilirini bulur.
/// Sıra: uygulama paketi içine gömülü → yaygın kurulum yolları → giriş kabuğunun PATH'i.
enum NodeLocator {
  static func find() -> String? {
    if let bundled = Bundle.main.url(forResource: "node", withExtension: nil, subdirectory: "engine"),
       FileManager.default.isExecutableFile(atPath: bundled.path) {
      return bundled.path
    }

    let candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
      return path
    }

    // nvm/Herd gibi kurulumlar yalnızca giriş kabuğunun PATH'inde olur.
    return findViaLoginShell()
  }

  private static func findViaLoginShell() -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-l", "-c", "command -v node"]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice

    do {
      try process.run()
    } catch {
      return nil
    }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()

    let path = String(data: data, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else {
      return nil
    }
    return path
  }

  /// Motorun bundle.js yolu: önce uygulama paketi, sonra geliştirme ağacı.
  static func engineScript() -> String? {
    if let bundled = Bundle.main.url(forResource: "engine", withExtension: "js", subdirectory: "engine") {
      return bundled.path
    }

    // Geliştirme: app/ ile engine/ kardeş dizinler.
    let devPath = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // UpSync
      .deletingLastPathComponent()  // Sources
      .deletingLastPathComponent()  // app
      .deletingLastPathComponent()  // upsync
      .appendingPathComponent("engine/dist/engine.js")
    if FileManager.default.fileExists(atPath: devPath.path) {
      return devPath.path
    }
    return nil
  }
}
