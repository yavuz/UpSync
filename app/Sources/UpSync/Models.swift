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

  var fileName: String {
    path.isEmpty ? "" : URL(fileURLWithPath: path).lastPathComponent
  }

  var isFailure: Bool { kind == .failed }
}
