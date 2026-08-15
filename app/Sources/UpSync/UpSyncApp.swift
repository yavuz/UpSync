import SwiftUI
import AppKit

@main
struct UpSyncApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra("UpSync", systemImage: "arrow.up.bin") {
      MenuBarView()
        .environmentObject(delegate.model)
    }

    Window("UpSync Activity", id: "activity") {
      ActivityView()
        .environmentObject(delegate.model)
    }
    .windowResizability(.contentSize)
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
