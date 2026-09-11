import Foundation
import Security
import LocalAuthentication
import CryptoKit
import Darwin

// Feasibility executable. Only a synthetic, non-persistent key is created.
// No profile paths or real credential values are accepted by this program.
func runProbe(authenticate: Bool) throws -> [String: String] {
    let context = LAContext()
    defer { context.invalidate() }
    context.localizedReason = "Verify Copse saved-secret encryption using synthetic test data"
    var authError: NSError?
    let authenticationAvailable = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError)
    var result = [
        "secureEnclave": SecureEnclave.isAvailable ? "available" : "unavailable",
        "authentication": authenticationAvailable ? "available" : "unavailable",
    ]
    guard authenticate else { return result }
    guard authenticationAvailable else { throw ProbeError.unavailable }
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .userPresence], &accessError
    ) else { throw ProbeError.accessControl }
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
            kSecAttrIsPermanent as String: false,
            kSecAttrAccessControl as String: access,
        ],
        kSecUseAuthenticationContext as String: context,
    ]
    var keyError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError),
          let publicKey = SecKeyCopyPublicKey(key) else {
        throw ProbeError.keyCreation(keyError?.takeRetainedValue())
    }
    let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
    guard SecKeyIsAlgorithmSupported(publicKey, .encrypt, algorithm),
          SecKeyIsAlgorithmSupported(key, .decrypt, algorithm) else {
        throw ProbeError.algorithm
    }
    let payload = Data("Copse synthetic Secure Enclave verification".utf8)
    var operationError: Unmanaged<CFError>?
    guard let sealed = SecKeyCreateEncryptedData(publicKey, algorithm, payload as CFData, &operationError) else {
        throw ProbeError.encryption
    }
    guard let opened = SecKeyCreateDecryptedData(key, algorithm, sealed, &operationError) else {
        throw ProbeError.decryption(operationError?.takeRetainedValue())
    }
    guard (opened as Data) == payload else { throw ProbeError.mismatch }
    result["roundTrip"] = "passed"
    return result
}

enum ProbeError: Error {
    case unavailable, accessControl, algorithm, encryption, mismatch
    case keyCreation(CFError?), decryption(CFError?)
}

func syntheticItem(_ id: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Copse Synthetic Vault Probe", kSecAttrAccount as String: id]
}
struct SyntheticEnvelope: Codable { let encapsulated: Data; let ciphertext: Data }
func persistentProbe() throws -> [String: String] {
    let id = UUID().uuidString.lowercased()
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .userPresence], &error) else { throw ProbeError.accessControl }
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    var item = syntheticItem(id)
    item[kSecValueData as String] = key.dataRepresentation
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ProbeError.unavailable }
    defer { SecItemDelete(syntheticItem(id) as CFDictionary) }
    var sender = try HPKE.Sender(recipientKey: key.publicKey, ciphersuite: .P256_SHA256_AES_GCM_256, info: Data("copse-vault-probe-v1".utf8))
    let ciphertext = try sender.seal(Data("Copse synthetic persistent key verification".utf8))
    let envelope = try JSONEncoder().encode(SyntheticEnvelope(encapsulated: sender.encapsulatedKey, ciphertext: ciphertext))
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    // A random test-item id and ciphertext of fixed synthetic text, never a key.
    process.arguments = ["--open-synthetic", id, envelope.base64EncodedString()]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw ProbeError.mismatch }
    return ["persistentRoundTrip": "passed", "syntheticKeyCleanup": "completed"]
}
func openSynthetic(_ args: [String]) throws -> [String: String] {
    guard args.count == 3, UUID(uuidString: args[1]) != nil, let encoded = Data(base64Encoded: args[2]) else { throw ProbeError.mismatch }
    let context = LAContext()
    context.localizedReason = "Verify Copse encryption with a temporary synthetic key"
    defer { context.invalidate() }
    var query = syntheticItem(args[1])
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let representation = item as? Data else { throw ProbeError.unavailable }
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation, authenticationContext: context)
    let envelope = try JSONDecoder().decode(SyntheticEnvelope.self, from: encoded)
    var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: .P256_SHA256_AES_GCM_256,
        info: Data("copse-vault-probe-v1".utf8), encapsulatedKey: envelope.encapsulated)
    let opened = try recipient.open(envelope.ciphertext)
    guard opened == Data("Copse synthetic persistent key verification".utf8) else { throw ProbeError.mismatch }
    return ["freshProcessUnwrap": "passed"]
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let result: [String: String]
    switch arguments.first {
    case "--probe" where arguments.count == 1: result = try runProbe(authenticate: false)
    case "--authenticate" where arguments.count == 1: result = try runProbe(authenticate: true)
    case "--persistent" where arguments.count == 1: result = try persistentProbe()
    case "--open-synthetic": result = try openSynthetic(arguments)
    default:
        fputs("Usage: CopseVaultProbe --probe | --authenticate | --persistent\n", stderr)
        exit(2)
    }
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
} catch {
    fputs("Native vault probe failed: \(error)\n", stderr)
    exit(1)
}
