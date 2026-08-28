import SwiftUI
import AppKit

/// Uygulama künyesi. Sürüm Info.plist'ten okunuyor; build.sh oraya kökteki
/// VERSION dosyasının içeriğini yazıyor. `swift run` ile geliştirirken paket
/// (ve dolayısıyla plist) olmadığı için "dev" gösteriliyor.
enum AppInfo {
  static let version: String = {
    let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    guard let value, !value.isEmpty else { return "dev" }
    return value
  }()

  /// Arayüzde gösterilen biçim: "v0.2.4".
  static var displayVersion: String { version == "dev" ? "dev" : "v\(version)" }
}

@main
struct UpSyncApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    // .window stili olmadan MenuBarExtra yerel bir NSMenu çiziyor ve
    // içine kart, ilerleme çubuğu, özel yerleşim konulamıyor.
    MenuBarExtra {
      PanelView()
        .environmentObject(delegate.model)
    } label: {
      MenuBarLabel(model: delegate.model)
    }
    .menuBarExtraStyle(.window)

    Window("UpSync Activity", id: "activity") {
      ActivityView()
        .environmentObject(delegate.model)
    }
    .defaultSize(width: 720, height: 480)

    Window("UpSync Settings", id: "settings") {
      SettingsView()
        .environmentObject(delegate.model)
    }
    .defaultSize(width: 720, height: 460)
    .windowResizability(.contentSize)
  }
}

/// Menü çubuğu ikonu toplu durumu yansıtır: boşta / aktarım / hata.
/// Ayrı bir View olması şart - App gövdesi ObservableObject'i gözlemlemez.
struct MenuBarLabel: View {
  @ObservedObject var model: AppModel

  var body: some View {
    Image(systemName: model.globalState.symbol)
  }
}

/// Uygulama menü çubuğu ajanı olarak çalışıyor (LSUIElement), yani açılışta
/// hiçbir pencere görünmüyor. Motorun başlatılması bir View'ın .task'ına
/// bağlanamaz - pencere hiç açılmayabilir.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = AppModel()

  nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      model.onPasswordRequest = { message, account, answer in
        PasswordPrompt.ask(message: message, account: account, completion: answer)
      }
      model.start()
    }
  }

  nonisolated func applicationWillTerminate(_ notification: Notification) {
    MainActor.assumeIsolated {
      model.stop()
    }
  }
}

/// Şifre sorusu pencere yaşam döngüsünden bağımsız olmalı; menü çubuğu
/// uygulamasında açık bir pencere garanti değil.
enum PasswordPrompt {
  @MainActor
  static func ask(
    message: String,
    account: String?,
    completion: @escaping (String?, Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "UpSync needs a password"
    alert.informativeText = account.map { "\(message)\n\nAccount: \($0)" } ?? message
    alert.addButton(withTitle: "Connect")
    alert.addButton(withTitle: "Cancel")

    let container = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 54))
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 30, width: 300, height: 24))
    let remember = NSButton(checkboxWithTitle: "Save to Keychain", target: nil, action: nil)
    remember.frame = NSRect(x: 0, y: 2, width: 300, height: 20)
    remember.state = account == nil ? .off : .on
    remember.isEnabled = account != nil
    container.addSubview(field)
    container.addSubview(remember)

    alert.accessoryView = container
    alert.window.initialFirstResponder = field

    NSApp.activate(ignoringOtherApps: true)
    let response = alert.runModal()
    guard response == .alertFirstButtonReturn else {
      completion(nil, false)
      return
    }
    completion(field.stringValue, remember.state == .on)
  }
}
