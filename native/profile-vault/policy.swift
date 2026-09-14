import Foundation
import CryptoKit

enum Failure: String, Error { case unavailable, cancelled, corrupt, unsupported, untrusted, recoveryRequired = "recovery-required" }
struct Request: Decodable {
    let operation: String
    let profileId: String
    let keyId: String
    let profilePath: String
    let deviceKeyId: String?
    let deviceEnvelope: String?
    let requireAuth: Bool?
    let manifestMac: String?
    let challenge: String?
    let recovery: String?
}

let trustedReleaseRequirement = "identifier \"dev.copse.app\" and anchor apple generic and certificate leaf[subject.OU] = \"VRQQV62MK3\" and ! entitlement[\"com.apple.security.cs.disable-library-validation\"] exists and ! entitlement[\"com.apple.security.cs.allow-dyld-environment-variables\"] exists and ! entitlement[\"com.apple.security.get-task-allow\"] exists"

// Operation policy is independent of whether routine unlock requires presence.
func sensitiveAuthenticationReason(_ operation: String) -> String? {
    switch operation {
    case "backup": return "Export the Copse recovery key"
    case "set-auth": return "Change Copse startup authentication"
    case "recover": return "Restore access to Copse saved secrets"
    default: return nil
    }
}

func verifyManifestKey(_ key: Data, request: Request) throws {
    guard let deviceId = request.deviceKeyId, let envelope = request.deviceEnvelope,
          let challenge = request.challenge, let recovery = request.recovery,
          ["verified", "not-backed-up"].contains(recovery),
          let encodedMac = request.manifestMac, let mac = Data(base64Encoded: encodedMac), mac.count == 32 else { throw Failure.corrupt }
    var payload: [Any] = [1, request.profileId, request.keyId, deviceId, envelope, recovery, challenge]
    if let required = request.requireAuth { payload.append(required) }
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
    let authKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: key),
        salt: Data(request.profileId.utf8), info: Data("copse-vault-manifest-v1".utf8), outputByteCount: 32)
    guard HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: data, using: authKey) else { throw Failure.corrupt }
}
