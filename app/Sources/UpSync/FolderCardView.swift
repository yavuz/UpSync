import SwiftUI
import AppKit

/// Panel içindeki tek klasör kartı: durum, hedef, canlı ilerleme ve
/// son işlem tek bakışta.
struct FolderCardView: View {
  @EnvironmentObject var model: AppModel
  let folder: WatchedFolder
  /// Göreli zamanların canlı kalması için dışarıdan verilen "şimdi".
  let now: Date

  private var status: FolderStatus? { model.statuses[folder.id] }
  private var transfer: TransferState { model.transferState(folder.id) }

  private var tone: StatusTone {
    if status?.error != nil { return .failure }
    if transfer.failed > 0 { return .failure }
    if !folder.enabled { return .disabled }
    if transfer.isActive { return .active }
    return status?.watching == true ? .active : .idle
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      header

      if let error = status?.error {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        destination
        activityLine
      }
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous)
        .fill(Color(nsColor: .controlBackgroundColor).opacity(0.6))
    )
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.08))
    )
  }

  private var header: some View {
    HStack(spacing: 7) {
      StatusDot(tone: tone, pulsing: transfer.isActive)

      Text(folder.displayName)
        .font(.system(size: 13, weight: .semibold))
        .lineLimit(1)

      Spacer(minLength: 4)

      if !folder.enabled {
        Text("paused")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      Menu {
        FolderActionsMenu(folder: folder)
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 22, height: 18)
          .contentShape(Rectangle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
    }
  }

  @ViewBuilder
  private var destination: some View {
    if let host = status?.host {
      HStack(spacing: 5) {
        Text(status?.protocolName?.uppercased() ?? "SFTP")
          .font(.system(size: 9, weight: .bold))
          .padding(.horizontal, 4)
          .padding(.vertical, 1)
          .background(
            RoundedRectangle(cornerRadius: 3)
              .fill(Color.secondary.opacity(0.15))
          )
        Text(host)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)

        if let profile = folder.profile {
          Text("· \(profile)")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  @ViewBuilder
  private var activityLine: some View {
    if transfer.isActive {
      HStack(spacing: 6) {
        ProgressView()
          .controlSize(.small)
          .scaleEffect(0.7)
          .frame(width: 12, height: 12)
        Text(inFlightLabel)
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
    } else if let kind = transfer.lastEvent,
              let name = transfer.lastFileName,
              let date = transfer.lastEventDate {
      HStack(spacing: 5) {
        Image(systemName: kind.symbol)
          .font(.system(size: 10))
          .foregroundStyle(kind.tint)
        Text(name)
          .font(.caption)
          .lineLimit(1)
          .truncationMode(.middle)
        Text("· \(RelativeTime.string(from: date, now: now))")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    } else if status?.autoUpload == false {
      Text("uploadOnSave is off in the config")
        .font(.caption)
        .foregroundStyle(.secondary)
    } else {
      Text("Watching · no transfers yet")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var inFlightLabel: String {
    let done = transfer.completed
    let active = transfer.inFlight
    if done > 0 {
      return "\(active) in progress · \(done) done"
    }
    return active == 1 ? "1 file in progress" : "\(active) files in progress"
  }
}

/// Kart üzerindeki ⋯ menüsü ve etkinlik penceresindeki bağlam menüsü ortak.
struct FolderActionsMenu: View {
  @EnvironmentObject var model: AppModel
  let folder: WatchedFolder

  private var status: FolderStatus? { model.statuses[folder.id] }

  var body: some View {
    Toggle("Upload on save", isOn: Binding(
      get: { folder.enabled },
      set: { model.setEnabled(folder, $0) }
    ))

    Divider()

    Button("Upload Folder") { model.uploadFolder(folder) }
    Button("Download Folder") { model.downloadFolder(folder) }

    Menu("Sync") {
      Button("Local → Remote") { model.sync(folder, direction: "localToRemote") }
      Button("Remote → Local") { model.sync(folder, direction: "remoteToLocal") }
      Button("Both Directions") { model.sync(folder, direction: "both") }
      Divider()
      Button("Local → Remote (delete extraneous)") {
        DestructiveSync.confirm(folder: folder) { model.sync(folder, direction: "localToRemote", delete: true) }
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
      NSWorkspace.shared.selectFile(status?.configPath, inFileViewerRootedAtPath: folder.path)
    }
    Button("Cancel Transfers") { model.cancel(folder) }
    Button("Forget Saved Password") { model.forgetPassword(folder) }

    Divider()

    Button("Remove Folder") { model.removeFolder(folder) }
  }
}

/// Geri alınamaz silme onayı. Panelden de ayarlardan da çağrılıyor.
enum DestructiveSync {
  @MainActor
  static func confirm(folder: WatchedFolder, perform: @escaping () -> Void) {
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
      perform()
    }
  }
}
