import Foundation

/// Kullanıcının eklediği klasör. Config dosyasının kendisi diskte kalır;
/// burada sadece hangi klasörün izlendiği ve seçilen profil tutulur.
struct WatchedFolder: Codable, Identifiable, Hashable {
  var id: String
  var path: String
  var enabled: Bool
  var profile: String?

  init(path: String, enabled: Bool = true, profile: String? = nil) {
    self.id = UUID().uuidString
    self.path = path
    self.enabled = enabled
    self.profile = profile
  }

  var displayName: String {
    URL(fileURLWithPath: path).lastPathComponent
  }
}

/// Bir klasörün o anki transfer durumu. Panel bunu kart üzerinde gösterir.
struct TransferState: Hashable {
  var inFlight: Int = 0
  var completed: Int = 0
  var failed: Int = 0
  var lastEvent: ActivityEntry.Kind?
  var lastFileName: String?
  var lastEventDate: Date?

  var isActive: Bool { inFlight > 0 }

  mutating func started() {
    inFlight += 1
  }

  mutating func finished(_ kind: ActivityEntry.Kind, fileName: String, at date: Date) {
    inFlight = max(0, inFlight - 1)
    if kind == .failed {
      failed += 1
    } else {
      completed += 1
    }
    lastEvent = kind
    lastFileName = fileName
    lastEventDate = date
  }

  /// Bir tur bittiğinde sayaçları sıfırla; kart "3 dosya" derken bir önceki
  /// turdan kalanları saymasın.
  mutating func resetCountsIfIdle() {
    guard inFlight == 0 else { return }
    completed = 0
    failed = 0
  }
}

/// Menü çubuğu ikonunun yansıttığı toplu durum.
enum GlobalState {
  case idle
  case syncing
  case error
  case starting

  var symbol: String {
    switch self {
    case .idle: return "arrow.up.bin"
    case .syncing: return "arrow.up.bin.fill"
    case .error: return "exclamationmark.triangle.fill"
    case .starting: return "arrow.up.bin"
    }
  }
}

/// Motorun bildirdiği canlı durum.
struct FolderStatus: Hashable {
  var id: String
  var name: String?
  var host: String?
  var protocolName: String?
  var watching: Bool
  var enabled: Bool
  var error: String?
  var profiles: [String]
  var profile: String?
  var autoUpload: Bool
  var autoDelete: Bool
  var configPath: String?

  init?(_ dict: [String: Any]) {
    guard let id = dict["id"] as? String else { return nil }
    self.id = id
    self.name = dict["name"] as? String
    self.host = dict["host"] as? String
    self.protocolName = dict["protocol"] as? String
    self.watching = dict["watching"] as? Bool ?? false
    self.enabled = dict["enabled"] as? Bool ?? false
    self.error = dict["error"] as? String
    self.profiles = dict["profiles"] as? [String] ?? []
    self.profile = dict["profile"] as? String
    self.autoUpload = dict["autoUpload"] as? Bool ?? false
    self.autoDelete = dict["autoDelete"] as? Bool ?? false
    self.configPath = dict["configPath"] as? String
  }
}

/// Aktivite kaydı. Sessiz başarısızlık bu uygulamanın çözmeye çalıştığı
/// asıl sorun, bu yüzden her işlem burada görünür.
struct ActivityEntry: Identifiable, Hashable {
  enum Kind: String {
    case uploaded
    case downloaded
    case deleted
    case skipped
    case failed
    case info
  }

  let id = UUID()
  let date: Date
  let kind: Kind
  let path: String
  let detail: String?
  let folderId: String?
  /// Motorun ham işlem türü ("upload" / "download" / "delete"). Bir hata
  /// tekrar denendiğinde hangi işlemin yeniden çalıştırılacağını bulmak
  /// için gerekiyor - `kind` bu bilgiyi "failed" durumunda kaybediyor.
  let operationKind: String?

  var fileName: String {
    path.isEmpty ? "" : URL(fileURLWithPath: path).lastPathComponent
  }

  /// Bu kaydın tek dosya için yeniden denenebilir olup olmadığı.
  var isRetryable: Bool {
    isFailure && folderId != nil && !path.isEmpty && operationKind != nil
  }

  var isFailure: Bool { kind == .failed }
}
