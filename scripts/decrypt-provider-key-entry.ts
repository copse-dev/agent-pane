/**
 * The Electron half of `scripts/decrypt-provider-key.mts` — see that file for
 * why the helper exists and how the two halves fit together. Bundled to a temp
 * file and exec'd by the launcher; never imported, and never run directly.
 *
 * All it adds to the launcher is the app's real cipher stack, assembled exactly
 * as `src/main/index.ts` assembles it: the keyring cipher in front, Electron's
 * `safeStorage` behind it for blobs written before #1898. Routing between the
 * two is the migrating cipher's job, on the blob's own magic — which is the
 * point of doing it this way rather than reimplementing either format here.
 *
 *   electron <bundle> <provider> <settings.json>
 *
 * Reads only. `settings.ts` upgrades a legacy blob to the current format when
 * the app reads one; this deliberately does not, because a debugging helper
 * that quietly rewrites the developer's profile is a bad trade.
 */
import { app, safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import {
  createKeyringCipher,
  createMigratingCipher,
  isKeyringCipherBlob,
} from '../src/main/services/storage/keyring-cipher.ts'
import {
  createOsKeyringStore,
  KEYRING_ACCOUNT,
  KEYRING_SERVICE,
} from '../src/main/services/storage/os-keyring.ts'
import { isRecord, parseJsonUnknown } from '../src/shared/unknown-value.mts'

// Must match src/main/app-init.ts: safeStorage derives its Keychain item from
// the app name, so under any other name it reaches for (and creates) a
// different item and every legacy blob fails to decrypt. The keyring cipher is
// unaffected — its item name is fixed and independent of the shell.
app.setName('Copse')

/** An exit-code-carrying failure, so every message leaves through one place. */
class Fatal extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function fail(message: string, code: number): never {
  throw new Fatal(message, code)
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decrypt(provider: string, settingsPath: string): string {
  let settings: unknown
  try {
    settings = parseJsonUnknown(readFileSync(settingsPath, 'utf8'))
  } catch (error) {
    fail(`cannot read ${settingsPath}: ${reason(error)}`, 4)
  }
  const keys = isRecord(settings) ? settings['apiKey'] : undefined
  const record = isRecord(keys) ? keys[provider] : undefined
  const enc = isRecord(record) ? record['enc'] : undefined
  if (typeof enc !== 'string' || enc === '') {
    fail(`no stored ${provider} key in ${settingsPath}`, 5)
  }
  const blob = Buffer.from(enc, 'base64')
  // `plain: true` means encryption was unavailable when the key was saved and
  // settings.json holds base64 of the plaintext (`setApiKey`'s consented
  // fallback), so there is nothing to decrypt.
  if (isRecord(record) && record['plain'] === true) return blob.toString('utf8')

  const cipher = createMigratingCipher(createKeyringCipher(createOsKeyringStore()), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  })
  try {
    return cipher.decryptString(blob)
  } catch (error) {
    fail(
      isKeyringCipherBlob(blob)
        ? `the stored ${provider} key is in the current keyring-cipher format and could not be ` +
            `opened: ${reason(error)}. Its data key is an ordinary keyring item, ` +
            `${KEYRING_SERVICE}/${KEYRING_ACCOUNT}, written the first time the app encrypted a ` +
            `secret — a profile copied from another machine brings the ciphertext but not the key.`
        : `the stored ${provider} key is in the legacy safeStorage format and could not be ` +
            `opened: ${reason(error)}. That format is bound to a Keychain item derived from the ` +
            `app name, so it only opens on the machine and under the identity that wrote it.`,
      6,
    )
  }
}

void app.whenReady().then(() => {
  app.dock?.hide()
  const provider = process.argv[2] ?? 'openrouter'
  const settingsPath = process.argv[3]
  // Exit only once the pipe has actually taken the bytes: stdout is
  // asynchronous when it is a pipe, and exiting on the same tick truncates it.
  try {
    if (typeof settingsPath !== 'string') fail('usage: <bundle> <provider> <settings.json>', 2)
    process.stdout.write(decrypt(provider, settingsPath), () => {
      app.exit(0)
    })
  } catch (error) {
    const code = error instanceof Fatal ? error.code : 1
    process.stderr.write(`[decrypt-provider-key] ${reason(error)}\n`, () => {
      app.exit(code)
    })
  }
})
