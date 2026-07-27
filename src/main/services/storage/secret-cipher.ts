// API keys are encrypted at rest with Electron's `safeStorage`, which is the
// only reason `settings.ts` imported `electron` at all. That single import put
// Electron on the path of all 36 of its importers — including
// `registry-bootstrap.ts` — so nothing downstream could be loaded outside the
// app (#1313).
//
// The dependency is inverted instead of cut: Electron installs the real cipher
// at boot, and `settings.ts` asks for whichever one is installed. Callers of
// `getApiKey`/`setApiKey` are untouched.
//
// With no cipher installed — a benchmark, a test, any headless caller — there is
// no OS keyring to talk to, so encryption is simply unavailable. That is the
// same state as a Linux box with no unlocked keyring, which the settings code
// already handles: reads of an encrypted key return null, and writes require
// explicit plaintext consent.

/** The slice of Electron's `safeStorage` that settings actually uses. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

let cipher: SecretCipher | null = null

export function setSecretCipher(next: SecretCipher | null): void {
  cipher = next
}

/** The installed cipher, or `null` when running without one. */
export function getSecretCipher(): SecretCipher | null {
  return cipher
}

/** Whether secrets can be encrypted at rest right now. */
export function isSecretEncryptionAvailable(): boolean {
  return cipher?.isEncryptionAvailable() ?? false
}
