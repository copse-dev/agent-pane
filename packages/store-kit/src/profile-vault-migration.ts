import { z } from 'zod'
import type { SecretCipher } from './secret-cipher.ts'
import {
  openVaultRecord,
  sealVaultRecord,
  verifyManifest,
  VaultError,
  type VaultManifest,
  type SecretRecordIdentity,
} from './profile-vault-crypto.ts'

const objectSchema = z.record(z.string(), z.unknown())
const secretSchema = z.strictObject({
  v: z.literal(1),
  enc: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
  plain: z.boolean().optional(),
})
export interface VaultMigrationResult {
  settings: Record<string, unknown>
  sshCredentials: Record<string, unknown>
  count: number
}
function object(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value)
  if (!parsed.success) throw new VaultError('corrupt')
  return parsed.data
}
function decodeBytes(encoded: string): Buffer {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new VaultError('corrupt')
  return bytes
}

/** Inventory is all-or-nothing. No input mutation, lazy sweeps or unreadable-record omission. */
export function migrateVaultStores(
  settingsValue: unknown,
  sshValue: unknown,
  legacy: SecretCipher,
  key: Buffer,
  manifest: VaultManifest,
): VaultMigrationResult {
  verifyManifest(key, manifest)
  const settings = structuredClone(object(settingsValue))
  const sshCredentials = structuredClone(object(sshValue))
  let count = 0
  const migrate = (
    value: unknown,
    identity: SecretRecordIdentity,
    allowPlaintext: boolean,
  ): unknown => {
    const parsed = secretSchema.safeParse(value)
    if (!parsed.success || (parsed.data.plain && !allowPlaintext)) throw new VaultError('corrupt')
    const bytes = decodeBytes(parsed.data.enc)
    let plain: string
    try {
      plain = parsed.data.plain ? bytes.toString('utf8') : legacy.decryptString(bytes, identity)
    } catch {
      throw new VaultError('corrupt')
    } finally {
      bytes.fill(0)
    }
    const sealed = sealVaultRecord(key, manifest, identity, plain)
    if (openVaultRecord(key, manifest, identity, sealed) !== plain) throw new VaultError('corrupt')
    count++
    return { v: 1, enc: sealed.toString('base64'), plain: false }
  }
  for (const [root, store] of [
    ['apiKey', 'api-key'],
    ['vncUsername', 'vnc-username'],
    ['vncPassword', 'vnc-password'],
  ] as const) {
    if (!Object.hasOwn(settings, root)) continue
    settings[root] = Object.fromEntries(
      Object.entries(object(settings[root])).map(([record, value]) => [
        record,
        migrate(value, { store, record }, root === 'apiKey'),
      ]),
    )
  }
  if (Object.hasOwn(sshCredentials, 'hosts')) {
    sshCredentials['hosts'] = Object.fromEntries(
      Object.entries(object(sshCredentials['hosts'])).map(([hostId, values]) => [
        hostId,
        Object.fromEntries(
          Object.entries(object(values)).map(([digest, value]) => [
            digest,
            migrate(value, { store: 'ssh', record: JSON.stringify([hostId, digest]) }, false),
          ]),
        ),
      ]),
    )
  }
  settings['savedSecretEncryption'] = {
    version: 1,
    profileId: manifest.profileId,
    keyId: manifest.keyId,
  }
  return { settings, sshCredentials, count }
}

/** Before replaying an interrupted commit, reject any staged plaintext or downgraded record. */
export function assertMigratedVaultStores(
  settings: unknown,
  ssh: unknown,
  manifest: VaultManifest,
): void {
  const inspect: SecretCipher = {
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new VaultError('unsupported')
    },
    decryptString: (bytes) => {
      if (
        bytes.length < 104 ||
        bytes.toString('utf8', 0, 4) !== 'CPS3' ||
        bytes.toString('utf8', 4, 40) !== manifest.profileId ||
        bytes.toString('utf8', 40, 76) !== manifest.keyId
      )
        throw new VaultError('corrupt')
      return ''
    },
  }
  // Inspection intentionally does not claim cryptographic verification while locked.
  const inspectRecord = (value: unknown): void => {
    const parsed = secretSchema.safeParse(value)
    if (!parsed.success || parsed.data.plain !== false) throw new VaultError('corrupt')
    inspect.decryptString(decodeBytes(parsed.data.enc))
  }
  const settingsObject = object(settings)
  for (const root of ['apiKey', 'vncUsername', 'vncPassword']) {
    if (Object.hasOwn(settingsObject, root))
      for (const value of Object.values(object(settingsObject[root]))) inspectRecord(value)
  }
  const sshObject = object(ssh)
  if (Object.hasOwn(sshObject, 'hosts'))
    for (const values of Object.values(object(sshObject['hosts']))) {
      for (const value of Object.values(object(values))) inspectRecord(value)
    }
}
