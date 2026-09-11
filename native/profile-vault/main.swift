import AppKit
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

// One request per inherited private socket. No listener, command-line secrets,
// environment credentials, stdout protocol or persisted unlock capability.
let channel = FileHandle(fileDescriptor: 3, closeOnDealloc: true)
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let context = LAContext()
context.localizedReason = "Unlock Copse saved secrets"
defer { context.invalidate() }

enum Failure: String, Error { case unavailable, cancelled, corrupt, unsupported, untrusted, recoveryRequired = "recovery-required" }
struct Request: Decodable {
    let operation: String
    let profileId: String
    let keyId: String
    let profilePath: String
    let deviceKeyId: String?
    let deviceEnvelope: String?
}
struct Payload: Codable {
    let version: Int
    let profileId: String
    let keyId: String
    let deviceKeyId: String
    let fingerprint: String
    let dataKey: String
}
struct Reply: Encodable {
    var ok: Bool
    var reason: String?
    var dataKey: String?
    var deviceKeyId: String?
    var deviceEnvelope: String?
    var recoveryVerified: Bool?
}
typealias DeviceKey = SecureEnclave.P256.KeyAgreement.PrivateKey
let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
let envelopeInfo = Data("copse-device-envelope-hpke-v1".utf8)
struct DeviceEnvelope: Codable {
    let version: Int
    let encapsulated: Data
    let ciphertext: Data
}
let recoveryPrefix = "COPSE-RECOVERY-1."

func uuid(_ text: String) -> Bool { UUID(uuidString: text)?.uuidString.lowercased() == text }
func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}
func alert(_ title: String, _ body: String, buttons: [String]) -> NSApplication.ModalResponse {
    let dialog = NSAlert()
    dialog.messageText = title
    dialog.informativeText = body
    for button in buttons { dialog.addButton(withTitle: button) }
    application.activate(ignoringOtherApps: true)
    return dialog.runModal()
}

// Kernel-supplied audit token identifies the creator of the socket, including
// PID version. It is never accepted from JSON and cannot be replaced by a UID.
func peerToken() throws -> Data {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) == 0,
          size == MemoryLayout<audit_token_t>.size else { throw Failure.untrusted }
    return withUnsafeBytes(of: &token) { Data($0) }
}
func caller(_ token: Data) throws -> SecCode {
    var code: SecCode?
    let attributes = [kSecGuestAttributeAudit: token] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
          let code, SecCodeCheckValidity(code, [], nil) == errSecSuccess else { throw Failure.untrusted }
    return code
}
func authorize(_ request: Request, token: Data) throws {
    let code = try caller(token)
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { throw Failure.untrusted }
    var path: CFURL?
    guard SecCodeCopyPath(staticCode, [], &path) == errSecSuccess, let path else { throw Failure.untrusted }
    // Even a correctly signed executable may load mutable development code.
    // Approval is per live request/channel; no path trust is persisted.
    let choice = alert("Allow access to Copse saved secrets?",
        "Application: \((path as URL).path)\n\nProfile: \(request.profilePath)\nProfile ID: \(request.profileId)\n\nApprove only an application and profile you intended to use. Authorization ends when this request finishes.",
        buttons: ["Allow", "Cancel"])
    guard choice == .alertFirstButtonReturn else { throw Failure.cancelled }
    guard try peerToken() == token else { throw Failure.untrusted }
    _ = try caller(token)
}
// The ordinary login Keychain stores CryptoKit's opaque, hardware-encrypted
// representation, never a private scalar or profile data key. Its default ACL
// is tied to this helper's stable signing identity. Enclave user presence is
// enforced when HPKE performs the private-key operation after restoration.
func deviceAttributes(_ id: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "Copse Device Vault",
     kSecAttrAccount as String: id]
}
func createDeviceKey(_ id: String) throws -> DeviceKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .userPresence], &error) else { throw Failure.unavailable }
    let key = try DeviceKey(accessControl: access, authenticationContext: context)
    var attributes = deviceAttributes(id)
    attributes[kSecValueData as String] = key.dataRepresentation
    guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw Failure.unavailable }
    return key
}
func loadDeviceKey(_ id: String) throws -> DeviceKey {
    var attributes = deviceAttributes(id)
    attributes[kSecReturnData as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &item)
    if status == errSecItemNotFound { throw Failure.recoveryRequired }
    if status == errSecUserCanceled { throw Failure.cancelled }
    guard status == errSecSuccess, let bytes = item as? Data, bytes.count <= 16384 else { throw Failure.unavailable }
    return try DeviceKey(dataRepresentation: bytes, authenticationContext: context)
}
func fingerprint(_ key: DeviceKey) -> String {
    SHA256.hash(data: key.publicKey.x963Representation).map { String(format: "%02x", $0) }.joined()
}
func seal(_ data: Data, key: DeviceKey) throws -> Data {
    var sender = try HPKE.Sender(recipientKey: key.publicKey, ciphersuite: suite, info: envelopeInfo)
    let ciphertext = try sender.seal(data)
    return try encode(DeviceEnvelope(version: 1, encapsulated: sender.encapsulatedKey, ciphertext: ciphertext))
}
func open(_ encrypted: Data, key: DeviceKey) throws -> Data {
    let envelope = try JSONDecoder().decode(DeviceEnvelope.self, from: encrypted)
    guard envelope.version == 1, envelope.encapsulated.count == 65, envelope.ciphertext.count <= 2048 else { throw Failure.corrupt }
    var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: envelopeInfo, encapsulatedKey: envelope.encapsulated)
    return try recipient.open(envelope.ciphertext)
}
func unlock(_ request: Request) throws -> Data {
    guard let id = request.deviceKeyId, uuid(id), let encoded = request.deviceEnvelope,
          let encrypted = Data(base64Encoded: encoded), encrypted.count <= 4096 else { throw Failure.corrupt }
    let device = try loadDeviceKey(id)
    var plaintext = try open(encrypted, key: device)
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    let payload = try JSONDecoder().decode(Payload.self, from: plaintext)
    guard payload.version == 1, payload.profileId == request.profileId, payload.keyId == request.keyId,
          payload.deviceKeyId == id, payload.fingerprint == fingerprint(device),
          let dataKey = Data(base64Encoded: payload.dataKey), dataKey.count == 32 else { throw Failure.corrupt }
    return dataKey
}
func wrap(_ dataKey: Data, request: Request) throws -> Reply {
    let id = UUID().uuidString.lowercased()
    let device = try createDeviceKey(id)
    var keep = false
    defer { if !keep { SecItemDelete(deviceAttributes(id) as CFDictionary) } }
    let payload = Payload(version: 1, profileId: request.profileId, keyId: request.keyId,
        deviceKeyId: id, fingerprint: fingerprint(device), dataKey: dataKey.base64EncodedString())
    var plain = try encode(payload)
    defer { plain.resetBytes(in: 0..<plain.count) }
    let encrypted = try seal(plain, key: device)
    var verified = try open(encrypted, key: device)
    defer { verified.resetBytes(in: 0..<verified.count) }
    guard verified == plain else { throw Failure.corrupt }
    keep = true
    return Reply(ok: true, dataKey: dataKey.base64EncodedString(), deviceKeyId: id, deviceEnvelope: encrypted.base64EncodedString())
}
func recoveryRecord(_ key: Data, request: Request) -> String {
    var payload = Data((request.profileId + request.keyId).utf8)
    payload.append(key)
    defer { payload.resetBytes(in: 0..<payload.count) }
    let encoded = payload.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let checksum = SHA256.hash(data: Data(recoveryPrefix.utf8) + payload).prefix(8).map { String(format: "%02x", $0) }.joined()
    return recoveryPrefix + encoded + "." + checksum
}
func importRecovery(_ request: Request) throws -> Data {
    let dialog = NSAlert()
    dialog.messageText = "Enter your Copse recovery key"
    dialog.informativeText = "Profile: \(request.profileId)\nUse the key saved independently in your password manager."
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 520, height: 28))
    dialog.accessoryView = field
    dialog.addButton(withTitle: "Verify")
    dialog.addButton(withTitle: "Cancel")
    application.activate(ignoringOtherApps: true)
    guard dialog.runModal() == .alertFirstButtonReturn else { throw Failure.cancelled }
    defer { field.stringValue = "" }
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.hasPrefix(recoveryPrefix), text.count == recoveryPrefix.count + 156 else { throw Failure.corrupt }
    let suffix = String(text.dropFirst(recoveryPrefix.count))
    let parts = suffix.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, parts[0].count == 139, parts[1].count == 16 else { throw Failure.corrupt }
    let base64 = parts[0].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
    guard var payload = Data(base64Encoded: base64), payload.count == 104 else { throw Failure.corrupt }
    defer { payload.resetBytes(in: 0..<payload.count) }
    guard String(data: payload.prefix(72), encoding: .utf8) == request.profileId + request.keyId else { throw Failure.corrupt }
    let key = Data(payload.suffix(32))
    guard recoveryRecord(key, request: request) == text else { throw Failure.corrupt }
    return key
}
func backup(_ request: Request) throws -> Reply {
    var key = try unlock(request)
    defer { key.resetBytes(in: 0..<key.count) }
    let dialog = NSAlert()
    dialog.messageText = "Back up your Copse recovery key"
    dialog.informativeText = "Save this key in your password manager, separately from your profile backup. Anyone holding it and the encrypted profile can open your saved secrets. Clipboard history or synchronization may retain a copy. The key cannot restore deleted profile files."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 520, height: 85))
    field.stringValue = recoveryRecord(key, request: request)
    field.isEditable = false
    field.isSelectable = true
    dialog.accessoryView = field
    dialog.addButton(withTitle: "Verify saved key")
    dialog.addButton(withTitle: "Cancel")
    application.activate(ignoringOtherApps: true)
    guard dialog.runModal() == .alertFirstButtonReturn else { throw Failure.cancelled }
    field.stringValue = ""
    var imported = try importRecovery(request)
    defer { imported.resetBytes(in: 0..<imported.count) }
    guard imported == key else { throw Failure.corrupt }
    return Reply(ok: true, recoveryVerified: true)
}

do {
    guard CommandLine.arguments.count == 1 else { throw Failure.unsupported }
    let token = try peerToken()
    var sizeBytes = Data()
    while sizeBytes.count < 4 {
        guard let part = try channel.read(upToCount: 4 - sizeBytes.count), !part.isEmpty else { throw Failure.corrupt }
        sizeBytes.append(part)
    }
    let count = sizeBytes.reduce(0) { ($0 << 8) | Int($1) }
    guard count > 0, count <= 16384 else { throw Failure.corrupt }
    var bytes = Data()
    while bytes.count < count {
        guard let part = try channel.read(upToCount: count - bytes.count), !part.isEmpty else { throw Failure.corrupt }
        bytes.append(part)
    }
    let request = try JSONDecoder().decode(Request.self, from: bytes)
    guard uuid(request.profileId), uuid(request.keyId), request.profilePath.count <= 4096,
          request.profilePath.hasPrefix("/") else { throw Failure.corrupt }
    guard SecureEnclave.isAvailable else { throw Failure.unavailable }
    if request.operation == "status" {
        _ = try caller(token)
        try channel.write(contentsOf: encode(Reply(ok: true)))
        exit(0)
    }
    try authorize(request, token: token)
    let reply: Reply
    switch request.operation {
    case "create":
        var key = Data(count: 32)
        defer { key.resetBytes(in: 0..<key.count) }
        guard key.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw Failure.unavailable }
        reply = try wrap(key, request: request)
    case "unlock":
        var key = try unlock(request)
        defer { key.resetBytes(in: 0..<key.count) }
        reply = Reply(ok: true, dataKey: key.base64EncodedString())
    case "backup": reply = try backup(request)
    case "recover":
        var key = try importRecovery(request)
        defer { key.resetBytes(in: 0..<key.count) }
        // Main verifies the recovered key against the authenticated manifest
        // before installing this new envelope. Existing records are never replaced here.
        reply = try wrap(key, request: request)
    default: throw Failure.unsupported
    }
    guard try peerToken() == token else { throw Failure.untrusted }
    _ = try caller(token)
    try channel.write(contentsOf: encode(reply))
} catch {
    let native = error as NSError
    let cancelled = (native.domain == LAError.errorDomain && [LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue].contains(native.code)) || native.code == Int(errSecUserCanceled)
    let reason = cancelled ? "cancelled" : (error as? Failure)?.rawValue ?? "corrupt"
    if let data = try? encode(Reply(ok: false, reason: reason)) { try? channel.write(contentsOf: data) }
    exit(1)
}
