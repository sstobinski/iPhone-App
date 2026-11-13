import Foundation
import Security

enum SavedConnection {
    private static let service = "WaveCompanion.LocalPairing"
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: "mac"] }
    
    static func load() -> ConnectionLink? {
        var request = query; request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let text = String(data: data, encoding: .utf8) else { return nil }
        return ConnectionLink.parse(text)
    }
    
    static func save(_ link: ConnectionLink) {
        clear(); var item = query
        item[kSecValueData as String] = Data(link.url.absoluteString.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        _ = SecItemAdd(item as CFDictionary, nil)
    }
    
    static func clear() { _ = SecItemDelete(query as CFDictionary) }
}
