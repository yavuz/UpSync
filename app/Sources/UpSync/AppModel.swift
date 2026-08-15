import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var folders: [WatchedFolder] = []
  @Published private(set) var statuses: [String: FolderStatus] = [:]
  @Published private(set) var activity: [ActivityEntry] = []
  @Published private(set) var transfers: [String: TransferState] = [:]
  @Published private(set) var engineRunning = false
  @Published private(set) var startupError: String?
  /// Şifre sorusunu gösterecek arayüz geri çağrısı (AppDelegate bağlar).
  /// (mesaj, hesap kimliği, yanıt) -> Void
  var onPasswordRequest: ((String, String?, @escaping (String?, Bool) -> Void) -> Void)?

  private var engine: EngineClient?
  private let maxActivity = 300

  // MARK: - Yaşam döngüsü

  func start() {
    folders = FolderStore.load()

    guard let nodePath = NodeLocator.find() else {
      startupError = "Node.js not found. Node 18+ must be installed (brew install node)."
      return
    }
    guard let enginePath = NodeLocator.engineScript() else {
      startupError = "Engine file (engine.js) not found. Run `npm run build`."
      return
    }

    let client = EngineClient(enginePath: enginePath, nodePath: nodePath)
    client.onNotification = { [weak self] method, params in
      self?.handle(method: method, params: params)
    }
    client.onStateChange = { [weak self] running in
      Task { @MainActor in
        self?.engineRunning = running
        if running {
          await self?.registerAllFolders()
        }
      }
    }
    engine = client

    do {
      try client.start()
      startupError = nil
    } catch {
      startupError = error.localizedDescription
    }
  }

  func stop() {
    engine?.shutdown()
  }

  private func registerAllFolders() async {
    for folder in folders {
      await register(folder)
    }
  }

  private func register(_ folder: WatchedFolder) async {
    guard let engine else { return }
    do {
      let result = try await engine.call("addFolder", [
        "id": folder.id,
        "path": folder.path,
        "enabled": folder.enabled,
        "profile": folder.profile as Any,
      ])
      applyStatus(result)
    } catch {
      log(.failed, path: folder.path, detail: error.localizedDescription, folderId: folder.id)
    }
  }

  // MARK: - Klasör yönetimi

  func addFolder(path: String) {
    guard !folders.contains(where: { $0.path == path }) else { return }
    let folder = WatchedFolder(path: path)
    folders.append(folder)
    FolderStore.save(folders)
    Task { await register(folder) }
  }

  func removeFolder(_ folder: WatchedFolder) {
    folders.removeAll { $0.id == folder.id }
    statuses[folder.id] = nil
    transfers[folder.id] = nil
    FolderStore.save(folders)
    Task { _ = try? await engine?.call("removeFolder", ["id": folder.id]) }
  }

  func setEnabled(_ folder: WatchedFolder, _ enabled: Bool) {
    guard let index = folders.firstIndex(where: { $0.id == folder.id }) else { return }
    folders[index].enabled = enabled
    FolderStore.save(folders)
    Task {
      let result = try? await engine?.call("setEnabled", ["id": folder.id, "enabled": enabled])
      applyStatus(result ?? nil)
    }
  }

  func setProfile(_ folder: WatchedFolder, _ profile: String?) {
    guard let index = folders.firstIndex(where: { $0.id == folder.id }) else { return }
    folders[index].profile = profile
    FolderStore.save(folders)
    Task {
      let result = try? await engine?.call("setProfile", ["id": folder.id, "profile": profile as Any])
      applyStatus(result ?? nil)
    }
  }

  func reload(_ folder: WatchedFolder) {
    Task {
      let result = try? await engine?.call("reloadFolder", ["id": folder.id])
      applyStatus(result ?? nil)
    }
  }

  // MARK: - Manuel işlemler

  func uploadFolder(_ folder: WatchedFolder) {
    run("upload", folder: folder, path: folder.path, label: "Upload")
  }

  func downloadFolder(_ folder: WatchedFolder) {
    run("download", folder: folder, path: folder.path, label: "Download")
  }

  func sync(_ folder: WatchedFolder, direction: String, delete: Bool = false) {
    let label = "Sync (\(direction))"
    Task {
      log(.info, path: folder.path, detail: "\(label) started", folderId: folder.id)
      do {
        _ = try await engine?.call("sync", [
          "id": folder.id,
          "path": folder.path,
          "direction": direction,
          "options": ["delete": delete],
        ])
        log(.info, path: folder.path, detail: "\(label) finished", folderId: folder.id)
      } catch {
        log(.failed, path: folder.path, detail: error.localizedDescription, folderId: folder.id)
      }
    }
  }

  /// Keychain'deki şifreyi siler; bir sonraki bağlantıda yeniden sorulur.
  func forgetPassword(_ folder: WatchedFolder) {
    guard let status = statuses[folder.id],
          let host = status.host else { return }
    // Hesap kimliği motorun ürettiğiyle aynı biçimde: kullanıcı@host:port
    for account in Keychain.accounts(matchingHost: host) {
      Keychain.removePassword(for: account)
    }
    log(.info, path: folder.path, detail: "Saved password cleared", folderId: folder.id)
    reload(folder)
  }

  func cancel(_ folder: WatchedFolder) {
    Task { _ = try? await engine?.call("cancel", ["id": folder.id]) }
  }

  private func run(_ method: String, folder: WatchedFolder, path: String, label: String) {
    Task {
      log(.info, path: path, detail: "\(label) started", folderId: folder.id)
      do {
        _ = try await engine?.call(method, ["id": folder.id, "path": path])
        log(.info, path: path, detail: "\(label) finished", folderId: folder.id)
      } catch {
        log(.failed, path: path, detail: error.localizedDescription, folderId: folder.id)
      }
    }
  }

  // MARK: - Şifre

  private func answerPassword(requestId: Int, password: String?) {
    engine?.notify("password:response", [
      "requestId": requestId,
      "password": password as Any,
    ])
  }

  // MARK: - Motor bildirimleri

  private func handle(method: String, params: [String: Any]) {
    switch method {
    case "event":
      handleEvent(params)
    case "log":
      let level = params["level"] as? String ?? "info"
      if level == "error" || level == "critical" {
        log(.failed, path: "", detail: params["message"] as? String, folderId: nil)
      }
    case "password:request":
      if let id = params["requestId"] as? Int {
        let message = params["prompt"] as? String ?? "Password required"
        let account = params["account"] as? String

        // Önce Keychain: kayıtlıysa kullanıcıya hiç sorma.
        if let account, let saved = Keychain.password(for: account) {
          answerPassword(requestId: id, password: saved)
          return
        }

        guard let onPasswordRequest else {
          answerPassword(requestId: id, password: nil)
          return
        }

        onPasswordRequest(message, account) { [weak self] password, remember in
          if let account, let password, remember {
            Keychain.setPassword(password, for: account)
          }
          self?.answerPassword(requestId: id, password: password)
        }
      }
    default:
      break
    }
  }

  private func handleEvent(_ event: [String: Any]) {
    let folderId = event["folderId"] as? String
    let path = event["localPath"] as? String ?? ""

    switch event["type"] as? String {
    case "transfer":
      let kind = event["kind"] as? String ?? "upload"
      let phase = event["phase"] as? String

      switch phase {
      case "start":
        // Aktivite listesine yazmıyoruz (şişer), ama panel ilerlemeyi
        // buradan biliyor.
        if let folderId {
          var state = transfers[folderId] ?? TransferState()
          state.resetCountsIfIdle()
          state.started()
          transfers[folderId] = state
        }

      case "done":
        let ms = event["ms"] as? Int
        let entryKind: ActivityEntry.Kind =
          kind == "delete" ? .deleted : (kind == "download" ? .downloaded : .uploaded)
        log(entryKind, path: path, detail: ms.map { "\($0) ms" }, folderId: folderId)
        finishTransfer(folderId, kind: entryKind, path: path)

      case "error":
        log(.failed, path: path, detail: event["message"] as? String, folderId: folderId)
        finishTransfer(folderId, kind: .failed, path: path)

      default:
        break
      }

    case "skipped":
      log(.skipped, path: path, detail: event["reason"] as? String, folderId: folderId)

    case "config":
      if event["ok"] as? Bool == false {
        log(.failed, path: "", detail: event["message"] as? String, folderId: folderId)
      }
      Task { await refreshStatuses() }

    case "watcher":
      let state = event["state"] as? String ?? ""
      if state == "error" {
        log(.failed, path: "", detail: event["message"] as? String, folderId: folderId)
      }
      Task { await refreshStatuses() }

    default:
      break
    }
  }

  func refreshStatuses() async {
    guard let engine else { return }
    guard let result = try? await engine.call("status"),
          let dict = result as? [String: Any],
          let list = dict["folders"] as? [[String: Any]] else {
      return
    }
    var next: [String: FolderStatus] = [:]
    for item in list {
      if let status = FolderStatus(item) {
        next[status.id] = status
      }
    }
    statuses = next
  }

  private func applyStatus(_ result: Any?) {
    guard let dict = result as? [String: Any], let status = FolderStatus(dict) else { return }
    statuses[status.id] = status
  }

  private func finishTransfer(_ folderId: String?, kind: ActivityEntry.Kind, path: String) {
    guard let folderId else { return }
    var state = transfers[folderId] ?? TransferState()
    let name = path.isEmpty ? "" : URL(fileURLWithPath: path).lastPathComponent
    state.finished(kind, fileName: name, at: Date())
    transfers[folderId] = state
  }

  func transferState(_ folderId: String) -> TransferState {
    transfers[folderId] ?? TransferState()
  }

  /// Menü çubuğu ikonunun yansıttığı toplu durum.
  var globalState: GlobalState {
    if startupError != nil { return .error }
    if !engineRunning { return .starting }
    if transfers.values.contains(where: { $0.isActive }) { return .syncing }
    if statuses.values.contains(where: { $0.error != nil }) { return .error }
    if transfers.values.contains(where: { $0.failed > 0 }) { return .error }
    return .idle
  }

  var activeFolderCount: Int {
    folders.filter { statuses[$0.id]?.watching == true }.count
  }

  private func log(_ kind: ActivityEntry.Kind, path: String, detail: String?, folderId: String?) {
    activity.insert(
      ActivityEntry(date: Date(), kind: kind, path: path, detail: detail, folderId: folderId),
      at: 0
    )
    if activity.count > maxActivity {
      activity.removeLast(activity.count - maxActivity)
    }
  }

  func clearActivity() {
    activity.removeAll()
  }

  var failureCount: Int {
    activity.prefix(50).filter(\.isFailure).count
  }
}

enum FolderStore {
  private static var url: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("UpSync", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base.appendingPathComponent("folders.json")
  }

  static func load() -> [WatchedFolder] {
    guard let data = try? Data(contentsOf: url),
          let folders = try? JSONDecoder().decode([WatchedFolder].self, from: data) else {
      return []
    }
    return folders
  }

  static func save(_ folders: [WatchedFolder]) {
    guard let data = try? JSONEncoder().encode(folders) else { return }
    try? data.write(to: url, options: .atomic)
  }
}
