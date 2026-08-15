import SwiftUI

struct ActivityView: View {
  @EnvironmentObject var model: AppModel
  @State private var onlyFailures = false

  private var entries: [ActivityEntry] {
    onlyFailures ? model.activity.filter(\.isFailure) : model.activity
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Toggle("Errors only", isOn: $onlyFailures)
          .toggleStyle(.checkbox)
        Spacer()
        Text(model.engineRunning ? "Engine running" : "Engine stopped")
          .foregroundStyle(model.engineRunning ? Color.secondary : Color.red)
          .font(.callout)
        Button("Clear") { model.clearActivity() }
      }
      .padding(10)

      Divider()

      if entries.isEmpty {
        ContentUnavailableView(
          "No activity yet",
          systemImage: "clock",
          description: Text("Saved files will show up here.")
        )
        .frame(maxHeight: .infinity)
      } else {
        List(entries) { entry in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(symbol(entry.kind))
              .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
              Text(entry.fileName.isEmpty ? (entry.detail ?? "—") : entry.fileName)
                .fontWeight(entry.isFailure ? .semibold : .regular)
                .foregroundStyle(entry.isFailure ? Color.red : Color.primary)
              if !entry.fileName.isEmpty, let detail = entry.detail {
                Text(detail)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              if !entry.path.isEmpty {
                Text(entry.path)
                  .font(.caption2)
                  .foregroundStyle(Color.secondary.opacity(0.7))
                  .lineLimit(1)
                  .truncationMode(.head)
              }
            }
            Spacer()
            Text(entry.date, format: .dateTime.hour().minute().second())
              .font(.caption)
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
          .padding(.vertical, 2)
        }
        .listStyle(.inset)
      }
    }
    .frame(minWidth: 520, minHeight: 380)
  }

  private func symbol(_ kind: ActivityEntry.Kind) -> String {
    switch kind {
    case .uploaded: return "↑"
    case .downloaded: return "↓"
    case .deleted: return "✕"
    case .skipped: return "–"
    case .failed: return "⚠"
    case .info: return "·"
    }
  }
}
