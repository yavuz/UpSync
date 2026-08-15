import SwiftUI
import AppKit

/// Menü çubuğu paneli. MenuBarExtra .window stilinde çalıştığı için
/// yerleşim tamamen bize ait.
struct PanelView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    // Göreli zaman etiketleri ("2s ago") kendiliğinden tazelensin.
    TimelineView(.periodic(from: .now, by: 10)) { context in
      content(now: context.date)
    }
    .frame(width: Metrics.panelWidth)
  }

  private func content(now: Date) -> some View {
    VStack(spacing: 0) {
      header
      Divider()

      if let error = model.startupError {
        startupProblem(error)
      } else if model.folders.isEmpty {
        emptyState
      } else {
        folderList(now: now)
        if !model.activity.isEmpty {
          Divider()
          recentActivity(now: now)
        }
      }

      Divider()
      footer
    }
  }

  // MARK: - Bölümler

  private var header: some View {
    HStack(spacing: 8) {
      Image(systemName: model.globalState.symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(model.globalState == .error ? Color.red : Color.accentColor)

      Text("UpSync")
        .font(.system(size: 13, weight: .semibold))

      Spacer()

      Text(summary)
        .font(.caption)
        .foregroundStyle(.secondary)

      Button {
        open("settings")
      } label: {
        Image(systemName: "gearshape")
          .font(.system(size: 12))
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .help("Settings")
    }
    .padding(.horizontal, Metrics.gutter)
    .padding(.vertical, 9)
  }

  private var summary: String {
    if model.startupError != nil { return "engine error" }
    if !model.engineRunning { return "starting…" }
    let active = model.transfers.values.reduce(0) { $0 + $1.inFlight }
    if active > 0 { return "\(active) transferring" }
    let watching = model.activeFolderCount
    return watching == 1 ? "1 folder" : "\(watching) folders"
  }

  private func folderList(now: Date) -> some View {
    ScrollView {
      VStack(spacing: 8) {
        ForEach(model.folders) { folder in
          FolderCardView(folder: folder, now: now)
        }
      }
      .padding(Metrics.gutter)
    }
    .frame(maxHeight: Metrics.panelMaxHeight)
    .scrollBounceBehavior(.basedOnSize)
  }

  private func recentActivity(now: Date) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Recent")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(.secondary)
        Spacer()
        Button("Show All") { open("activity") }
          .buttonStyle(.plain)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, Metrics.gutter)
      .padding(.top, 8)
      .padding(.bottom, 4)

      ForEach(model.activity.prefix(4)) { entry in
        ActivityRow(entry: entry, folderName: folderName(entry.folderId), now: now, compact: true)
          .padding(.horizontal, Metrics.gutter)
          .padding(.vertical, 3)
      }
      .padding(.bottom, 6)
    }
  }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Image(systemName: "folder.badge.plus")
        .font(.system(size: 26))
        .foregroundStyle(.secondary)
      Text("No folders yet")
        .font(.system(size: 13, weight: .medium))
      Text("Add a project folder that contains an sftp.json.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 26)
    .padding(.horizontal, Metrics.gutter)
  }

  private func startupProblem(_ error: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Engine could not start", systemImage: "exclamationmark.triangle.fill")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.red)
      Text(error)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(Metrics.gutter)
  }

  private var footer: some View {
    HStack(spacing: 10) {
      Button {
        FolderPicker.choose { model.addFolder(path: $0) }
      } label: {
        Label("Add Folder", systemImage: "plus")
          .font(.caption)
      }
      .buttonStyle(.plain)

      Spacer()

      Button {
        open("activity")
      } label: {
        HStack(spacing: 4) {
          Text("Activity").font(.caption)
          if model.failureCount > 0 {
            Text("\(model.failureCount)")
              .font(.system(size: 9, weight: .bold))
              .padding(.horizontal, 4)
              .padding(.vertical, 1)
              .background(Capsule().fill(Color.red))
              .foregroundStyle(.white)
          }
        }
      }
      .buttonStyle(.plain)

      Button("Quit") {
        model.stop()
        NSApplication.shared.terminate(nil)
      }
      .buttonStyle(.plain)
      .font(.caption)
      .keyboardShortcut("q")
    }
    .foregroundStyle(.secondary)
    .padding(.horizontal, Metrics.gutter)
    .padding(.vertical, 8)
  }

  // MARK: - Yardımcılar

  private func folderName(_ id: String?) -> String? {
    guard let id else { return nil }
    return model.folders.first { $0.id == id }?.displayName
  }

  /// LSUIElement uygulamasında pencere açarken uygulamayı öne almazsak
  /// pencere diğer her şeyin arkasında açılıyor.
  private func open(_ id: String) {
    NSApp.activate(ignoringOtherApps: true)
    openWindow(id: id)
  }
}

/// Klasör seçme paneli. Panel odağı kaybedip kapanır, bu beklenen davranış.
enum FolderPicker {
  @MainActor
  static func choose(_ completion: @escaping (String) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Add"
    panel.message = "Choose a project folder containing an sftp.json"

    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url {
      completion(url.path)
    }
  }
}
