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
    var requireAuth: Bool?
    var automatic: Bool?
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
// Silent access is restricted to our sealed, hardened release app. The marker
// is covered by its resource signature and only shipped alongside the required
// Electron fuses. Mutable development runtimes always require explicit approval.
func trustedRelease(_ token: Data) throws -> Bool {
    let code = try caller(token)
    var requirement: SecRequirement?

    guard SecRequirementCreateWithString(trustedReleaseRequirement as CFString, [], &requirement) == errSecSuccess,
          let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any],
          let flags = values[kSecCodeInfoFlags as String] as? UInt32, flags & 0x10000 != 0,
          let plist = values[kSecCodeInfoPList as String] as? [String: Any],
          plist["CopseVaultSilentAccess"] as? String == "1" else { return false }
    return SecStaticCodeCheckValidity(staticCode,
        SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode), requirement) == errSecSuccess
}
func authorize(_ request: Request, token: Data) throws -> Bool {
    if try trustedRelease(token) { return false }
    let code = try caller(token)
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { throw Failure.untrusted }
    var path: CFURL?
    guard SecCodeCopyPath(staticCode, [], &path) == errSecSuccess, let path else { throw Failure.untrusted }
    let choice = alert("Allow access to Copse saved secrets?",
        "Application: \((path as URL).path)\n\nProfile: \(request.profilePath)\nProfile ID: \(request.profileId)\n\nThis development application cannot unlock silently. Approve only an application and profile you intended to use.",
        buttons: ["Allow", "Cancel"])
    guard choice == .alertFirstButtonReturn else { throw Failure.cancelled }
    guard try peerToken() == token else { throw Failure.untrusted }
    _ = try caller(token)
    try authenticateSensitiveAction("Authorize development access to Copse saved secrets")
    return true
}

// One Keychain value owns the active device key, envelope and policy together.
// Switching policy atomically replaces this value; an old profile manifest can
// never select an older, less restrictive device key. Main repairs its mirror
// from the reply after verifying the unchanged profile data key.
struct DeviceRecord: Codable {
    let version: Int
    let profileId: String
    let keyId: String
    let deviceKeyId: String
    let deviceEnvelope: String
    let requireAuth: Bool
    let keyData: Data
}
func legacyAttributes(_ id: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "Copse Device Vault",
     kSecAttrAccount as String: id]
}
func recordAttributes(_ request: Request) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "Copse Device Vault Profiles",
     kSecAttrAccount as String: request.profileId + ":" + request.keyId]
}
func readItem(_ attributes: [String: Any]) throws -> Data? {
    var query = attributes
    query[kSecReturnData as String] = true
    // Even status must never turn into a Keychain approval dialog.
    let readContext = LAContext()
    readContext.interactionNotAllowed = true
    defer { readContext.invalidate() }
    query[kSecUseAuthenticationContext as String] = readContext
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = item as? Data, bytes.count <= 32768 else { throw Failure.unavailable }
    return bytes
}
func readRecord(_ request: Request) throws -> DeviceRecord? {
    guard let bytes = try readItem(recordAttributes(request)) else { return nil }
    let record = try JSONDecoder().decode(DeviceRecord.self, from: bytes)
    guard record.version == 1, record.profileId == request.profileId, record.keyId == request.keyId,
          uuid(record.deviceKeyId), record.keyData.count <= 16384,
          record.deviceEnvelope.count <= 8192 else { throw Failure.corrupt }
    return record
}
func writeRecord(_ record: DeviceRecord, request: Request) throws {
    let attributes = recordAttributes(request)
    let data = try encode(record)
    let update = [kSecValueData as String: data]
    let status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
        var inserted = attributes
        inserted[kSecValueData as String] = data
        guard SecItemAdd(inserted as CFDictionary, nil) == errSecSuccess else { throw Failure.unavailable }
    } else if status != errSecSuccess { throw Failure.unavailable }
}
func loadRecord(_ request: Request) throws -> DeviceRecord {
    if let record = try readRecord(request) { return record }
    // Compatibility with the original, always-authenticated vault. New records
    // are never stored by deviceKeyId, so old envelopes cannot bypass a policy change.
    guard let id = request.deviceKeyId, uuid(id), let envelope = request.deviceEnvelope,
          let bytes = try readItem(legacyAttributes(id)) else { throw Failure.recoveryRequired }
    return DeviceRecord(version: 1, profileId: request.profileId, keyId: request.keyId,
        deviceKeyId: id, deviceEnvelope: envelope, requireAuth: true, keyData: bytes)
}
func createDeviceKey(requireAuth: Bool) throws -> DeviceKey {
    var error: Unmanaged<CFError>?
    let flags: SecAccessControlCreateFlags = requireAuth ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        flags, &error) else { throw Failure.unavailable }
    return try DeviceKey(accessControl: access, authenticationContext: context)
}
// Every sensitive operation uses a new helper process/context. Authenticate even
// when the data key is already unlocked or the device key has no presence flag.
final class AuthenticationResult: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var granted = false
    func finish(_ success: Bool) {
        lock.lock(); granted = success; lock.unlock()
        semaphore.signal()
    }
    func wait() -> Bool {
        guard semaphore.wait(timeout: .now() + 90) == .success else { return false }
        lock.lock(); defer { lock.unlock() }
        return granted
    }
}
func authenticateSensitiveAction(_ reason: String) throws {
    let result = AuthenticationResult()
    context.localizedReason = reason
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in result.finish(success) }
    guard result.wait() else { throw Failure.cancelled }
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
func unlockRecord(_ record: DeviceRecord) throws -> Data {
    guard let encrypted = Data(base64Encoded: record.deviceEnvelope), encrypted.count <= 4096 else { throw Failure.corrupt }
    let device = try DeviceKey(dataRepresentation: record.keyData, authenticationContext: context)
    var plaintext = try open(encrypted, key: device)
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    let payload = try JSONDecoder().decode(Payload.self, from: plaintext)
    guard payload.version == 1, payload.profileId == record.profileId, payload.keyId == record.keyId,
          payload.deviceKeyId == record.deviceKeyId, payload.fingerprint == fingerprint(device),
          let dataKey = Data(base64Encoded: payload.dataKey), dataKey.count == 32 else { throw Failure.corrupt }
    return dataKey
}
func makeRecord(_ dataKey: Data, request: Request, requireAuth: Bool) throws -> DeviceRecord {
    let id = UUID().uuidString.lowercased()
    let device = try createDeviceKey(requireAuth: requireAuth)
    let payload = Payload(version: 1, profileId: request.profileId, keyId: request.keyId,
        deviceKeyId: id, fingerprint: fingerprint(device), dataKey: dataKey.base64EncodedString())
    var plain = try encode(payload)
    defer { plain.resetBytes(in: 0..<plain.count) }
    let encrypted = try seal(plain, key: device)
    var verified = try open(encrypted, key: device)
    defer { verified.resetBytes(in: 0..<verified.count) }
    guard verified == plain else { throw Failure.corrupt }
    return DeviceRecord(version: 1, profileId: request.profileId, keyId: request.keyId,
        deviceKeyId: id, deviceEnvelope: encrypted.base64EncodedString(), requireAuth: requireAuth,
        keyData: device.dataRepresentation)
}
func keyReply(_ key: Data, record: DeviceRecord) -> Reply {
    Reply(ok: true, dataKey: key.base64EncodedString(), deviceKeyId: record.deviceKeyId,
        deviceEnvelope: record.deviceEnvelope, requireAuth: record.requireAuth)
}
func adoptLegacy(_ record: DeviceRecord, request: Request) throws {
    if try readRecord(request) != nil { return }
    // Called only after a successful private-key operation proved the legacy key.
    try writeRecord(record, request: request)
    SecItemDelete(legacyAttributes(record.deviceKeyId) as CFDictionary)
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
    let record = try loadRecord(request)
    var key = try unlockRecord(record)
    defer { key.resetBytes(in: 0..<key.count) }
    try verifyManifestKey(key, request: request)
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
    try adoptLegacy(record, request: request)
    var reply = keyReply(key, record: record)
    reply.recoveryVerified = true
    return reply
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
        let record = try readRecord(request)
        try channel.write(contentsOf: encode(Reply(ok: true, requireAuth: record?.requireAuth ?? request.requireAuth ?? true,
            automatic: try trustedRelease(token))))
        exit(0)
    }
    // Enrollment must never display a developer approval prompt on startup.
    if request.operation == "create", try !trustedRelease(token) { throw Failure.untrusted }
    let authenticatedCaller = try authorize(request, token: token)
    if let reason = sensitiveAuthenticationReason(request.operation), !authenticatedCaller {
        try authenticateSensitiveAction(reason)
    }
    let reply: Reply
    switch request.operation {
    case "create":
        context.interactionNotAllowed = true
        guard try readRecord(request) == nil else { throw Failure.corrupt }
        var key = Data(count: 32)
        defer { key.resetBytes(in: 0..<key.count) }
        guard key.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw Failure.unavailable }
        let record = try makeRecord(key, request: request, requireAuth: false)
        try writeRecord(record, request: request)
        reply = keyReply(key, record: record)
    case "unlock":
        let record = try loadRecord(request)
        if !record.requireAuth && !authenticatedCaller { context.interactionNotAllowed = true }
        var key = try unlockRecord(record)
        defer { key.resetBytes(in: 0..<key.count) }
        try adoptLegacy(record, request: request)
        reply = keyReply(key, record: record)
    case "backup": reply = try backup(request)
    case "set-auth":
        guard let required = request.requireAuth else { throw Failure.corrupt }
        let previous = try loadRecord(request)
        var key = try unlockRecord(previous)
        defer { key.resetBytes(in: 0..<key.count) }
        let record = try makeRecord(key, request: request, requireAuth: required)
        try writeRecord(record, request: request)
        SecItemDelete(legacyAttributes(previous.deviceKeyId) as CFDictionary)
        reply = keyReply(key, record: record)
    case "recover":
        var key = try importRecovery(request)
        defer { key.resetBytes(in: 0..<key.count) }
        // Verify the original manifest before changing native state, including on
        // a replacement Mac. A wrong recovery key cannot poison a later retry.
        try verifyManifestKey(key, request: request)
        let record = try makeRecord(key, request: request, requireAuth: request.requireAuth ?? true)
        try writeRecord(record, request: request)
        reply = keyReply(key, record: record)
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
