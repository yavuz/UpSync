import Foundation

/// Node motoruyla satır ayraçlı JSON üzerinden konuşan istemci.
/// Motor süreci beklenmedik şekilde ölürse otomatik yeniden başlatılır.
///
/// Değişebilir durumun tamamı (`process`, `buffer`, `pending`, ...) yalnızca
/// `queue` üzerinde okunup yazılır; bu yüzden @unchecked Sendable.
final class EngineClient: @unchecked Sendable {
  enum EngineError: LocalizedError {
    case nodeNotFound
    case engineNotFound(String)
    case notRunning
    case remote(String)

    var errorDescription: String? {
      switch self {
      case .nodeNotFound:
        return "Node.js not found. Node 18 or later is required."
      case .engineNotFound(let path):
        return "Engine file not found: \(path)"
      case .notRunning:
        return "The engine is not running."
      case .remote(let message):
        return message
      }
    }
  }

  private let enginePath: String
  private let nodePath: String

  private var process: Process?
  private var stdinPipe: Pipe?
  private var buffer = Data()
  private var nextId = 0
  private var pending: [Int: CheckedContinuation<Any?, Error>] = [:]
  private let queue = DispatchQueue(label: "engine.client")

  /// Motordan gelen bildirimler (event / log / connection / password:request).
  var onNotification: ((String, [String: Any]) -> Void)?
  var onStateChange: ((Bool) -> Void)?

  private var intentionalShutdown = false
  private var restartAttempts = 0

  init(enginePath: String, nodePath: String) {
    self.enginePath = enginePath
    self.nodePath = nodePath
  }

  var isRunning: Bool {
    queue.sync { process?.isRunning ?? false }
  }

  func start() throws {
    guard FileManager.default.isExecutableFile(atPath: nodePath) else {
      throw EngineError.nodeNotFound
    }
    guard FileManager.default.fileExists(atPath: enginePath) else {
      throw EngineError.engineNotFound(enginePath)
    }

    // GUI uygulamaları launchd'den 256'lık bir soft fd limiti devralır.
    // Motor hem dosya izler hem SSH bağlantısı açar; 256 büyük projelerde
    // yetmiyor (EMFILE, SSH anahtarı bile açılamıyor). Çocuk süreç bu limiti
    // miras aldığı için spawn'dan önce yükseltiyoruz.
    Self.raiseFileLimit()

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: nodePath)
    proc.arguments = [enginePath]

    let inPipe = Pipe()
    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardInput = inPipe
    proc.standardOutput = outPipe
    proc.standardError = errPipe

    outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      self?.queue.async { self?.ingest(data) }
    }

    // Motorun stderr'i protokolün parçası değil; sadece teşhis için.
    errPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      FileHandle.standardError.write(Data("[engine] \(text)".utf8))
    }

    proc.terminationHandler = { [weak self] _ in
      self?.handleTermination()
    }

    try proc.run()

    queue.sync {
      self.process = proc
      self.stdinPipe = inPipe
      self.restartAttempts = 0
    }
    onStateChange?(true)
  }

  /// RLIMIT_NOFILE soft limitini yükseltir.
  /// Sınır kern.maxfilesperproc (61440); "sınırsız" değeri doğrudan
  /// verilemez, macOS EINVAL döner.
  private static func raiseFileLimit() {
    var limits = rlimit()
    guard getrlimit(RLIMIT_NOFILE, &limits) == 0 else { return }

    let ceiling: rlim_t = 61440  // kern.maxfilesperproc
    let hard = min(limits.rlim_max, ceiling)
    guard limits.rlim_cur < hard else { return }

    limits.rlim_cur = hard
    if setrlimit(RLIMIT_NOFILE, &limits) != 0 {
      FileHandle.standardError.write(Data("could not raise the file descriptor limit\n".utf8))
    }
  }

  func shutdown() {
    intentionalShutdown = true
    Task { _ = try? await call("shutdown") }
    queue.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      self?.process?.terminate()
    }
  }

  private func handleTermination() {
    onStateChange?(false)

    queue.async { [weak self] in
      guard let self else { return }
      // Bekleyen çağrıları serbest bırak, yoksa arayüz kilitlenir.
      for (_, continuation) in self.pending {
        continuation.resume(throwing: EngineError.notRunning)
      }
      self.pending.removeAll()
      self.process = nil
      self.stdinPipe = nil

      guard !self.intentionalShutdown else { return }

      // Üstel geri çekilmeyle yeniden başlat.
      self.restartAttempts += 1
      let delay = min(30.0, pow(2.0, Double(min(self.restartAttempts, 5))))
      self.queue.asyncAfter(deadline: .now() + delay) {
        try? self.start()
      }
    }
  }

  @discardableResult
  func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
    let id: Int = queue.sync {
      nextId += 1
      return nextId
    }

    let payload: [String: Any] = ["id": id, "method": method, "params": params]
    let data = try JSONSerialization.data(withJSONObject: payload)

    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard let pipe = self.stdinPipe else {
          continuation.resume(throwing: EngineError.notRunning)
          return
        }
        self.pending[id] = continuation
        var line = data
        line.append(0x0A)
        pipe.fileHandleForWriting.write(line)
      }
    }
  }

  /// Şifre isteğine yanıt - id'siz bildirim.
  func notify(_ method: String, _ params: [String: Any]) {
    queue.async {
      guard let pipe = self.stdinPipe else { return }
      let payload: [String: Any] = ["method": method, "params": params]
      guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
      data.append(0x0A)
      pipe.fileHandleForWriting.write(data)
    }
  }

  // MARK: - Gelen veri

  private func ingest(_ data: Data) {
    buffer.append(data)
    while let index = buffer.firstIndex(of: 0x0A) {
      let line = buffer[buffer.startIndex..<index]
      buffer = buffer[buffer.index(after: index)...]
      if !line.isEmpty {
        handle(line: Data(line))
      }
    }
  }

  private func handle(line: Data) {
    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
      return
    }

    if let id = object["id"] as? Int {
      guard let continuation = pending.removeValue(forKey: id) else { return }
      if let error = object["error"] as? [String: Any] {
        let message = error["message"] as? String ?? "Unknown engine error"
        continuation.resume(throwing: EngineError.remote(message))
      } else {
        continuation.resume(returning: object["result"])
      }
      return
    }

    if let method = object["method"] as? String {
      let params = object["params"] as? [String: Any] ?? [:]
      DispatchQueue.main.async { [weak self] in
        self?.onNotification?(method, params)
      }
    }
  }
}
