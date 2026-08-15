import SwiftUI
import AppKit

/// Tek bir etkinlik satırı. Panelde kompakt, etkinlik penceresinde geniş hali.
struct ActivityRow: View {
  let entry: ActivityEntry
  let folderName: String?
  let now: Date
  var compact: Bool = false

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      Image(systemName: entry.kind.symbol)
        .font(.system(size: compact ? 11 : 13))
        .foregroundStyle(entry.kind.tint)
        .frame(width: compact ? 13 : 16)

      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.system(size: compact ? 11 : 12, weight: entry.isFailure ? .semibold : .regular))
          .foregroundStyle(entry.isFailure ? Color.red : Color.primary)
          .lineLimit(1)
          .truncationMode(.middle)

        if !compact, let subtitle {
          Text(subtitle)
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .lineLimit(entry.isFailure ? 3 : 1)
            .truncationMode(.head)
            .fixedSize(horizontal: false, vertical: entry.isFailure)
        }
      }

      Spacer(minLength: 6)

      if let folderName {
        Text(folderName)
          .font(.system(size: compact ? 9 : 10))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 5)
          .padding(.vertical, 1)
          .background(Capsule().fill(Color.secondary.opacity(0.12)))
          .lineLimit(1)
      }

      Text(RelativeTime.string(from: entry.date, now: now))
        .font(.system(size: compact ? 9 : 10))
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .frame(minWidth: compact ? 44 : 56, alignment: .trailing)
    }
  }

  private var title: String {
    if entry.fileName.isEmpty {
      return entry.detail ?? entry.kind.label
    }
    return entry.fileName
  }

  private var subtitle: String? {
    if entry.fileName.isEmpty { return nil }
    if entry.isFailure { return entry.detail }
    if let detail = entry.detail {
      return "\(abbreviateHome(entry.path)) · \(detail)"
    }
    return abbreviateHome(entry.path)
  }
}

/// Tam etkinlik günlüğü: arama, klasör filtresi, sadece hatalar.
struct ActivityView: View {
  @EnvironmentObject var model: AppModel

  @State private var search = ""
  @State private var onlyFailures = false
  @State private var folderFilter: String?

  private var entries: [ActivityEntry] {
    model.activity.filter { entry in
      if onlyFailures && !entry.isFailure { return false }
      if let folderFilter, entry.folderId != folderFilter { return false }
      if !search.isEmpty {
        let needle = search.lowercased()
        return entry.path.lowercased().contains(needle)
          || (entry.detail?.lowercased().contains(needle) ?? false)
      }
      return true
    }
  }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 10)) { context in
      VStack(spacing: 0) {
        toolbar
        Divider()
        list(now: context.date)
        Divider()
        statusBar
      }
    }
    .frame(minWidth: 620, minHeight: 420)
  }

  private var toolbar: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
        .font(.system(size: 11))
      TextField("Search files", text: $search)
        .textFieldStyle(.plain)
        .font(.system(size: 12))
        .frame(maxWidth: 220)

      Divider().frame(height: 16)

      Picker("", selection: $folderFilter) {
        Text("All folders").tag(String?.none)
        ForEach(model.folders) { folder in
          Text(folder.displayName).tag(String?.some(folder.id))
        }
      }
      .labelsHidden()
      .frame(maxWidth: 160)

      Toggle("Errors only", isOn: $onlyFailures)
        .toggleStyle(.checkbox)
        .font(.system(size: 12))

      Spacer()

      Button("Clear") { model.clearActivity() }
        .font(.system(size: 12))
        .disabled(model.activity.isEmpty)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  @ViewBuilder
  private func list(now: Date) -> some View {
    if entries.isEmpty {
      ContentUnavailableView {
        Label(model.activity.isEmpty ? "No activity yet" : "No matches",
              systemImage: model.activity.isEmpty ? "clock" : "line.3.horizontal.decrease.circle")
      } description: {
        Text(model.activity.isEmpty
             ? "Saved files will show up here."
             : "Try a different search or filter.")
      }
      .frame(maxHeight: .infinity)
    } else {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
            ActivityRow(entry: entry, folderName: folderName(entry.folderId), now: now)
              .padding(.horizontal, 12)
              .padding(.vertical, 5)
              .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.03))
              .contextMenu {
                if !entry.path.isEmpty {
                  Button("Reveal in Finder") {
                    NSWorkspace.shared.selectFile(entry.path, inFileViewerRootedAtPath: "")
                  }
                  Button("Copy Path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(entry.path, forType: .string)
                  }
                }
                if let detail = entry.detail, entry.isFailure {
                  Button("Copy Error") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(detail, forType: .string)
                  }
                }
              }
          }
        }
      }
    }
  }

  private var statusBar: some View {
    HStack(spacing: 8) {
      StatusDot(tone: model.engineRunning ? .active : .failure)
      Text(model.engineRunning ? "Engine running" : "Engine stopped")
        .font(.system(size: 11))
        .foregroundStyle(.secondary)

      Spacer()

      Text("\(entries.count) of \(model.activity.count)")
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }

  private func folderName(_ id: String?) -> String? {
    guard let id else { return nil }
    return model.folders.first { $0.id == id }?.displayName
  }
}
