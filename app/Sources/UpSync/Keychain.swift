import Foundation
import Security

/// Şifreler config dosyasında değil Keychain'de tutulur.
enum Keychain {
  private static let service = "dev.upsync.app"

  static func password(for account: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  @discardableResult
  static func setPassword(_ password: String, for account: String) -> Bool {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]

    SecItemDelete(base as CFDictionary)

    var attributes = base
    attributes[kSecValueData as String] = Data(password.utf8)
    return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
  }

  /// Belirli bir sunucuya ait kayıtlı hesapları döndürür.
  /// Hesap kimliği motorun ürettiği biçimdedir: `kullanici@host:port`.
  static func accounts(matchingHost host: String) -> [String] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]

    var items: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
          let entries = items as? [[String: Any]] else {
      return []
    }

    return entries
      .compactMap { $0[kSecAttrAccount as String] as? String }
      .filter { $0.contains("@\(host)") }
  }

  @discardableResult
  static func removePassword(for account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    return SecItemDelete(query as CFDictionary) == errSecSuccess
  }
}
