import Foundation
import Security

/// The key shared with the Mac, kept on this watch alone.
enum Keychain {
    private static let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "jester-watch",
        kSecAttrAccount as String: "mac"
    ]

    static func load() -> Data? {
        var found: CFTypeRef?
        let query = item.merging([kSecReturnData as String: true]) { $1 }
        return SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess ? found as? Data : nil
    }

    static func save(_ data: Data) {
        SecItemDelete(item as CFDictionary)
        // Steering runs with the wrist down, when the watch may be locked in other ways.
        let attributes = item.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { $1 }
        SecItemAdd(attributes as CFDictionary, nil)
    }
}
