import SwiftUI

/// Ortak ölçüler ve durum renkleri. Sistem renkleri kullanılıyor, böylece
/// koyu/açık tema ve erişilebilirlik ayarlarına kendiliğinden uyuyor.
enum Metrics {
  static let panelWidth: CGFloat = 352
  static let panelMaxHeight: CGFloat = 560
  static let cardRadius: CGFloat = 10
  static let gutter: CGFloat = 12
}

enum StatusTone {
  case active
  case idle
  case failure
  case disabled

  var color: Color {
    switch self {
    case .active: return .green
    case .idle: return .secondary
    case .failure: return .red
    case .disabled: return Color.secondary.opacity(0.4)
    }
  }
}

/// Klasör kartındaki ve satırlardaki durum noktası.
struct StatusDot: View {
  let tone: StatusTone
  var pulsing: Bool = false

  @State private var on = false

  var body: some View {
    Circle()
      .fill(tone.color)
      .frame(width: 8, height: 8)
      .opacity(pulsing ? (on ? 0.35 : 1) : 1)
      .animation(
        pulsing ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : .default,
        value: on
      )
      .onAppear { if pulsing { on = true } }
      .onChange(of: pulsing) { _, active in on = active }
  }
}

extension ActivityEntry.Kind {
  var symbol: String {
    switch self {
    case .uploaded: return "arrow.up.circle.fill"
    case .downloaded: return "arrow.down.circle.fill"
    case .deleted: return "trash.circle.fill"
    case .skipped: return "minus.circle.fill"
    case .failed: return "exclamationmark.triangle.fill"
    case .info: return "info.circle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .uploaded: return .accentColor
    case .downloaded: return .teal
    case .deleted: return .orange
    case .skipped: return .secondary
    case .failed: return .red
    case .info: return .secondary
    }
  }

  var label: String {
    switch self {
    case .uploaded: return "Uploaded"
    case .downloaded: return "Downloaded"
    case .deleted: return "Deleted"
    case .skipped: return "Skipped"
    case .failed: return "Failed"
    case .info: return "Info"
    }
  }
}

/// "2s ago" biçiminde kısa göreli zaman.
enum RelativeTime {
  private static let formatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .abbreviated
    return f
  }()

  static func string(from date: Date, now: Date = Date()) -> String {
    if now.timeIntervalSince(date) < 2 {
      return "just now"
    }
    return formatter.localizedString(for: date, relativeTo: now)
  }
}

/// Yolu kullanıcıya gösterirken ev dizinini ~ ile kısaltır.
func abbreviateHome(_ path: String) -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
