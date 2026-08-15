import SwiftUI
import AppKit

/// Klasör yönetimi penceresi: solda liste, sağda detay.
struct SettingsView: View {
  @EnvironmentObject var model: AppModel
  @State private var selection: String?

  var body: some View {
    NavigationSplitView {
      sidebar
    } detail: {
      if let selection, let folder = model.folders.first(where: { $0.id == selection }) {
        FolderDetailView(folder: folder)
      } else {
        ContentUnavailableView {
          Label("No folder selected", systemImage: "folder")
        } description: {
          Text("Select a folder on the left, or add a new one.")
        }
      }
    }
    .navigationSplitViewStyle(.balanced)
    .onAppear {
      if selection == nil { selection = model.folders.first?.id }
    }
  }

  private var sidebar: some View {
    VStack(spacing: 0) {
      List(selection: $selection) {
        ForEach(model.folders) { folder in
          HStack(spacing: 7) {
            StatusDot(tone: tone(for: folder))
            VStack(alignment: .leading, spacing: 1) {
              Text(folder.displayName)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
              if let host = model.statuses[folder.id]?.host {
                Text(host)
                  .font(.system(size: 10))
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
                  .truncationMode(.middle)
              }
            }
          }
          .padding(.vertical, 2)
          .tag(folder.id)
        }
      }
      .listStyle(.sidebar)

      Divider()

      HStack(spacing: 6) {
        Button {
          FolderPicker.choose { path in
            model.addFolder(path: path)
            selection = model.folders.last?.id
          }
        } label: {
          Image(systemName: "plus")
        }
        .buttonStyle(.borderless)
        .help("Add folder")

        Button {
          if let selection, let folder = model.folders.first(where: { $0.id == selection }) {
            model.removeFolder(folder)
            self.selection = model.folders.first?.id
          }
        } label: {
          Image(systemName: "minus")
        }
        .buttonStyle(.borderless)
        .disabled(selection == nil)
        .help("Remove folder")

        Spacer()
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
    }
    .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
  }

  private func tone(for folder: WatchedFolder) -> StatusTone {
    let status = model.statuses[folder.id]
    if status?.error != nil { return .failure }
    if !folder.enabled { return .disabled }
    return status?.watching == true ? .active : .idle
  }
}

/// Seçili klasörün detayları. Config dosyası editörde açılır; burada
/// düzenlenmez - tek doğruluk kaynağı diskteki sftp.json.
struct FolderDetailView: View {
  @EnvironmentObject var model: AppModel
  let folder: WatchedFolder

  private var status: FolderStatus? { model.statuses[folder.id] }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        headerSection

        if let error = status?.error {
          errorSection(error)
        } else {
          connectionSection
          behaviourSection
          actionsSection
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var headerSection: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(folder.displayName)
        .font(.system(size: 17, weight: .semibold))
      Text(abbreviateHome(folder.path))
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }
  }

  private func errorSection(_ error: String) -> some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 8) {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(.red)
          .font(.system(size: 12))
          .fixedSize(horizontal: false, vertical: true)
        Button("Reload Config") { model.reload(folder) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  private var connectionSection: some View {
    GroupBox("Connection") {
      VStack(alignment: .leading, spacing: 8) {
        row("Protocol", status?.protocolName?.uppercased() ?? "—")
        row("Host", status?.host ?? "—")
        if let configPath = status?.configPath {
          HStack(alignment: .firstTextBaseline) {
            Text("Config")
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
              .frame(width: 88, alignment: .leading)
            Text(relativeConfig(configPath))
              .font(.system(size: 11, design: .monospaced))
              .textSelection(.enabled)
            Spacer()
            Button("Open") { NSWorkspace.shared.open(URL(fileURLWithPath: configPath)) }
              .controlSize(.small)
            Button("Reveal") {
              NSWorkspace.shared.selectFile(configPath, inFileViewerRootedAtPath: folder.path)
            }
            .controlSize(.small)
          }
        }
        if let profiles = status?.profiles, !profiles.isEmpty {
          HStack {
            Text("Profile")
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
              .frame(width: 88, alignment: .leading)
            Picker("", selection: Binding(
              get: { folder.profile },
              set: { model.setProfile(folder, $0) }
            )) {
              Text("Default").tag(String?.none)
              ForEach(profiles, id: \.self) { Text($0).tag(String?.some($0)) }
            }
            .labelsHidden()
            .frame(maxWidth: 200)
            Spacer()
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  private var behaviourSection: some View {
    GroupBox("Behaviour") {
      VStack(alignment: .leading, spacing: 8) {
        Toggle("Upload on save", isOn: Binding(
          get: { folder.enabled },
          set: { model.setEnabled(folder, $0) }
        ))
        .font(.system(size: 12))

        if status?.autoUpload == false {
          Text("The config has uploadOnSave and watcher.autoUpload both off, so nothing is watched.")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        HStack(spacing: 6) {
          Image(systemName: status?.autoDelete == true ? "checkmark.square" : "square")
            .foregroundStyle(.secondary)
            .font(.system(size: 11))
          Text("Mirror deletions (watcher.autoDelete)")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
        }
        Text("Read from the config file; change it there.")
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  private var actionsSection: some View {
    GroupBox("Actions") {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Button("Upload Folder") { model.uploadFolder(folder) }
          Button("Download Folder") { model.downloadFolder(folder) }
          Button("Reload Config") { model.reload(folder) }
        }
        HStack(spacing: 8) {
          Button("Sync →") { model.sync(folder, direction: "localToRemote") }
          Button("Sync ←") { model.sync(folder, direction: "remoteToLocal") }
          Button("Sync ↔") { model.sync(folder, direction: "both") }
          Button("Sync → (delete)") {
            DestructiveSync.confirm(folder: folder) {
              model.sync(folder, direction: "localToRemote", delete: true)
            }
          }
        }
        HStack(spacing: 8) {
          Button("Cancel Transfers") { model.cancel(folder) }
          Button("Forget Saved Password") { model.forgetPassword(folder) }
        }
      }
      .controlSize(.small)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .frame(width: 88, alignment: .leading)
      Text(value)
        .font(.system(size: 11, design: .monospaced))
        .textSelection(.enabled)
      Spacer()
    }
  }

  private func relativeConfig(_ path: String) -> String {
    let prefix = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
    return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : abbreviateHome(path)
  }
}
