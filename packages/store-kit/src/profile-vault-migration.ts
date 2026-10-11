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

/**
 * A source record that stops migration. `record` names the store and record
 * key only (provider, host id); it never carries credential material.
 */
export class VaultMigrationBlockedError extends VaultError {
  readonly record: string
  constructor(record: string) {
    super('corrupt')
    this.record = record
  }
}
const SETTINGS_ROOTS = [
  ['apiKey', 'api-key'],
  ['vncUsername', 'vnc-username'],
  ['vncPassword', 'vnc-password'],
] as const
function describeRecord(store: (typeof SETTINGS_ROOTS)[number][1], record: string): string {
  switch (store) {
    case 'api-key':
      return `saved API key “${record}”`
    case 'vnc-username':
      return `saved VNC username for “${record}”`
    case 'vnc-password':
      return `saved VNC password for “${record}”`
  }
}

/**
 * Walk every saved credential, decoding each with the legacy cipher. `seal`
 * replaces the record; without it the walk is a read-only inventory.
 */
function transformVaultStores(
  settingsValue: unknown,
  sshValue: unknown,
  legacy: SecretCipher,
  seal?: (identity: SecretRecordIdentity, plain: string) => unknown,
): VaultMigrationResult {
  const settings = structuredClone(object(settingsValue))
  const sshCredentials = structuredClone(object(sshValue))
  let count = 0
  const migrate = (
    value: unknown,
    identity: SecretRecordIdentity,
    allowPlaintext: boolean,
    label: string,
  ): unknown => {
    const parsed = secretSchema.safeParse(value)
    if (!parsed.success || (parsed.data.plain && !allowPlaintext))
      throw new VaultMigrationBlockedError(label)
    let bytes: Buffer
    try {
      bytes = decodeBytes(parsed.data.enc)
    } catch {
      throw new VaultMigrationBlockedError(label)
    }
    let plain: string
    try {
      plain = parsed.data.plain ? bytes.toString('utf8') : legacy.decryptString(bytes, identity)
    } catch {
      throw new VaultMigrationBlockedError(label)
    } finally {
      bytes.fill(0)
    }
    count++
    return seal ? seal(identity, plain) : value
  }
  const records = (value: unknown, label: string): Record<string, unknown> => {
    try {
      return object(value)
    } catch {
      throw new VaultMigrationBlockedError(label)
    }
  }
  for (const [root, store] of SETTINGS_ROOTS) {
    if (!Object.hasOwn(settings, root)) continue
    settings[root] = Object.fromEntries(
      Object.entries(records(settings[root], `settings.json “${root}”`)).map(([record, value]) => [
        record,
        migrate(value, { store, record }, root === 'apiKey', describeRecord(store, record)),
      ]),
    )
  }
  if (Object.hasOwn(sshCredentials, 'hosts')) {
    sshCredentials['hosts'] = Object.fromEntries(
      Object.entries(records(sshCredentials['hosts'], 'ssh-credentials.json “hosts”')).map(
        ([hostId, values]) => [
          hostId,
          Object.fromEntries(
            Object.entries(records(values, `saved SSH credentials for host “${hostId}”`)).map(
              ([digest, value]) => [
                digest,
                migrate(
                  value,
                  { store: 'ssh', record: JSON.stringify([hostId, digest]) },
                  false,
                  `saved SSH credential for host “${hostId}”`,
                ),
              ],
            ),
          ),
        ],
      ),
    )
  }
  return { settings, sshCredentials, count }
}

/**
 * Read-only dry run of {@link migrateVaultStores}: proves every source record
 * decodes before any native key is created. Returns the record count.
 */
export function inventoryVaultStores(
  settingsValue: unknown,
  sshValue: unknown,
  legacy: SecretCipher,
): number {
  return transformVaultStores(settingsValue, sshValue, legacy).count
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
  const result = transformVaultStores(settingsValue, sshValue, legacy, (identity, plain) => {
    const sealed = sealVaultRecord(key, manifest, identity, plain)
    if (openVaultRecord(key, manifest, identity, sealed) !== plain) throw new VaultError('corrupt')
    return { v: 1, enc: sealed.toString('base64'), plain: false }
  })
  result.settings['savedSecretEncryption'] = {
    version: 1,
    profileId: manifest.profileId,
    keyId: manifest.keyId,
  }
  return result
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
