import SwiftUI
import AppKit

struct MenuBarView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    if let error = model.startupError {
      Text(error)
      Divider()
    } else if !model.engineRunning {
      Text("Motor başlatılıyor…")
      Divider()
    }

    if model.folders.isEmpty {
      Text("Henüz klasör eklenmedi")
    }

    ForEach(model.folders) { folder in
      folderMenu(folder)
    }

    if !model.folders.isEmpty {
      Divider()
    }

    Button("Klasör Ekle…") { chooseFolder() }

    Button("Etkinlik…") { openWindow(id: "activity") }
      .badge(model.failureCount)

    Divider()

    Button("Çıkış") {
      model.stop()
      NSApplication.shared.terminate(nil)
    }
    .keyboardShortcut("q")
  }

  @ViewBuilder
  private func folderMenu(_ folder: WatchedFolder) -> some View {
    let status = model.statuses[folder.id]

    Menu("\(statusSymbol(status)) \(folder.displayName)") {
      if let error = status?.error {
        Text(error)
        Divider()
      } else if let host = status?.host {
        Text("\(status?.protocolName?.uppercased() ?? "SFTP") · \(host)")
        // Birden fazla sftp.json olabilir (.zed / .vscode / kök).
        // Hangisinin okunduğu görünür olmalı.
        if let configPath = status?.configPath {
          Text("config: \(shortConfigPath(configPath, in: folder.path))")
        }
        Divider()
      }

      Toggle("Kaydedince yükle", isOn: Binding(
        get: { folder.enabled },
        set: { model.setEnabled(folder, $0) }
      ))

      if status?.autoUpload == false {
        Text("config'te uploadOnSave kapalı")
      }

      Divider()

      Button("Klasörü Yükle") { model.uploadFolder(folder) }
      Button("Klasörü İndir") { model.downloadFolder(folder) }

      Menu("Senkronize Et") {
        Button("Lokal → Uzak") { model.sync(folder, direction: "localToRemote") }
        Button("Uzak → Lokal") { model.sync(folder, direction: "remoteToLocal") }
        Button("Çift Yönlü") { model.sync(folder, direction: "both") }
        Divider()
        Button("Lokal → Uzak (fazlalıkları sil)") {
          confirmDestructiveSync(folder)
        }
      }

      if let profiles = status?.profiles, !profiles.isEmpty {
        Divider()
        Menu("Profil: \(folder.profile ?? "varsayılan")") {
          Button("Varsayılan") { model.setProfile(folder, nil) }
          ForEach(profiles, id: \.self) { profile in
            Button(profile) { model.setProfile(folder, profile) }
          }
        }
      }

      Divider()
      Button("Config'i Yeniden Yükle") { model.reload(folder) }
      Button("Finder'da Göster") {
        NSWorkspace.shared.selectFile(
          status?.configPath,
          inFileViewerRootedAtPath: folder.path
        )
      }
      Button("Transferleri İptal Et") { model.cancel(folder) }
      Button("Kayıtlı Şifreyi Unut") { model.forgetPassword(folder) }
      Divider()
      Button("Klasörü Kaldır") { model.removeFolder(folder) }
    }
  }

  /// Config yolunu klasöre göre kısaltır: ".vscode/sftp.json" gibi.
  private func shortConfigPath(_ configPath: String, in folderPath: String) -> String {
    let prefix = folderPath.hasSuffix("/") ? folderPath : folderPath + "/"
    return configPath.hasPrefix(prefix)
      ? String(configPath.dropFirst(prefix.count))
      : configPath
  }

  private func statusSymbol(_ status: FolderStatus?) -> String {
    guard let status else { return "○" }
    if status.error != nil { return "⚠" }
    if status.watching { return "●" }
    return "○"
  }

  private func chooseFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Ekle"
    panel.message = "İçinde sftp.json bulunan proje klasörünü seçin"

    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url {
      model.addFolder(path: url.path)
    }
  }

  // Silmeli senkron geri alınamaz; onaysız çalıştırmıyoruz.
  private func confirmDestructiveSync(_ folder: WatchedFolder) {
    let alert = NSAlert()
    alert.messageText = "Uzaktaki fazlalıklar silinsin mi?"
    alert.informativeText = """
      \(folder.displayName) klasöründe lokalde bulunmayan uzak dosyalar \
      kalıcı olarak silinecek. Bu işlem geri alınamaz.
      """
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Senkronize Et ve Sil")
    alert.addButton(withTitle: "Vazgeç")

    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      model.sync(folder, direction: "localToRemote", delete: true)
    }
  }
}
