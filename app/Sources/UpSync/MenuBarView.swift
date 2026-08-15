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
      Text("Starting engine…")
      Divider()
    }

    if model.folders.isEmpty {
      Text("No folders added yet")
    }

    ForEach(model.folders) { folder in
      folderMenu(folder)
    }

    if !model.folders.isEmpty {
      Divider()
    }

    Button("Add Folder…") { chooseFolder() }

    Button("Activity…") { openWindow(id: "activity") }
      .badge(model.failureCount)

    Divider()

    Button("Quit") {
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

      Toggle("Upload on save", isOn: Binding(
        get: { folder.enabled },
        set: { model.setEnabled(folder, $0) }
      ))

      if status?.autoUpload == false {
        Text("uploadOnSave is off in the config")
      }

      Divider()

      Button("Upload Folder") { model.uploadFolder(folder) }
      Button("Download Folder") { model.downloadFolder(folder) }

      Menu("Sync") {
        Button("Local → Remote") { model.sync(folder, direction: "localToRemote") }
        Button("Remote → Local") { model.sync(folder, direction: "remoteToLocal") }
        Button("Both Directions") { model.sync(folder, direction: "both") }
        Divider()
        Button("Local → Remote (delete extraneous)") {
          confirmDestructiveSync(folder)
        }
      }

      if let profiles = status?.profiles, !profiles.isEmpty {
        Divider()
        Menu("Profile: \(folder.profile ?? "default")") {
          Button("Default") { model.setProfile(folder, nil) }
          ForEach(profiles, id: \.self) { profile in
            Button(profile) { model.setProfile(folder, profile) }
          }
        }
      }

      Divider()
      Button("Reload Config") { model.reload(folder) }
      Button("Reveal in Finder") {
        NSWorkspace.shared.selectFile(
          status?.configPath,
          inFileViewerRootedAtPath: folder.path
        )
      }
      Button("Cancel Transfers") { model.cancel(folder) }
      Button("Forget Saved Password") { model.forgetPassword(folder) }
      Divider()
      Button("Remove Folder") { model.removeFolder(folder) }
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
    panel.prompt = "Add"
    panel.message = "Choose a project folder containing an sftp.json"

    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url {
      model.addFolder(path: url.path)
    }
  }

  // Silmeli senkron geri alınamaz; onaysız çalıştırmıyoruz.
  private func confirmDestructiveSync(_ folder: WatchedFolder) {
    let alert = NSAlert()
    alert.messageText = "Delete extraneous remote files?"
    alert.informativeText = """
      Remote files in \(folder.displayName) that do not exist locally will be \
      permanently deleted. This cannot be undone.
      """
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Sync and Delete")
    alert.addButton(withTitle: "Cancel")

    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      model.sync(folder, direction: "localToRemote", delete: true)
    }
  }
}
