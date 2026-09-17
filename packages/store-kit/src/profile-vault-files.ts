import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { decodeVaultManifest, VaultError, type VaultManifest } from './profile-vault-crypto.ts'
import { assertMigratedVaultStores, type VaultMigrationResult } from './profile-vault-migration.ts'

const FILES = ['settings.json', 'ssh-credentials.json', 'vault-manifest.json'] as const
const journalSchema = z.strictObject({
  version: z.literal(1),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(3),
})
const objectSchema = z.record(z.string(), z.unknown())
const STAGING = '.vault-migration'
function regular(path: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024)
    throw new VaultError('corrupt')
}
function directory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new VaultError('corrupt')
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
/** Caller must hold exclusive profile ownership across this write. */
export function writeVaultFile(
  directoryPath: string,
  filename: (typeof FILES)[number],
  contents: string,
): void {
  directory(directoryPath)
  const target = join(directoryPath, filename)
  if (existsSync(target)) regular(target)
  const temporary = join(directoryPath, `.vault-write-${randomUUID()}`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, target)
    syncDirectory(directoryPath)
  } finally {
    rmSync(temporary, { force: true })
  }
}
export function readVaultManifest(userData: string): VaultManifest | null {
  const path = join(userData, 'vault-manifest.json')
  if (!existsSync(path)) return null
  regular(path)
  return decodeVaultManifest(readFileSync(path, 'utf8'))
}
export function readVaultSource(
  userData: string,
  file: 'settings.json' | 'ssh-credentials.json',
): Record<string, unknown> {
  const path = join(userData, file)
  if (!existsSync(path)) return {}
  regular(path)
  const object = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(objectSchema))
  if (!object) throw new VaultError('corrupt')
  return object
}
/**
 * All staged files contain ciphertext. The durable journal is the commit point;
 * after it exists, failures are recovered by replay, never by legacy fallback.
 * The manifest is installed last and stores must stay closed until replay ends.
 */
export function commitVaultMigration(
  userData: string,
  migrated: VaultMigrationResult,
  manifest: VaultManifest,
): void {
  directory(userData)
  if (readVaultManifest(userData)) throw new VaultError('unsupported')
  assertMigratedVaultStores(migrated.settings, migrated.sshCredentials, manifest)
  for (const filename of FILES) {
    const target = join(userData, filename)
    if (existsSync(target)) regular(target)
  }
  const staging = join(userData, `.vault-preparing-${randomUUID()}`)
  mkdirSync(staging, { mode: 0o700 })
  let committed = false
  try {
    const contents = [
      JSON.stringify(migrated.settings),
      JSON.stringify(migrated.sshCredentials),
      JSON.stringify(manifest),
    ]
    for (const [index, file] of FILES.entries()) {
      const text = contents[index]
      if (text === undefined) throw new VaultError('corrupt')
      writeVaultFile(staging, file, text)
    }
    const journal = JSON.stringify({
      version: 1,
      hashes: contents.map((text) => createHash('sha256').update(text).digest('hex')),
    })
    const fd = openSync(join(staging, 'commit.json'), 'wx', 0o600)
    try {
      writeFileSync(fd, journal)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncDirectory(staging)
    renameSync(staging, join(userData, STAGING))
    committed = true
    syncDirectory(userData)
    recoverVaultMigration(userData)
  } finally {
    if (!committed) rmSync(staging, { recursive: true, force: true })
  }
}
/** Call under exclusive ownership, before installing any persistent-store backend. */
export function recoverVaultMigration(userData: string): boolean {
  const staging = join(userData, STAGING)
  if (!existsSync(staging)) return false
  directory(userData)
  directory(staging)
  const journalPath = join(staging, 'commit.json')
  // An incomplete preparation never changes the source. Preserve it for an
  // explicit retry/cleanup instead of interpreting it as an enabled vault.
  if (!existsSync(journalPath)) throw new VaultError('corrupt')
  regular(journalPath)
  const journal = safeJsonParse(readFileSync(journalPath, 'utf8'), decodeWithSchema(journalSchema))
  if (!journal) throw new VaultError('corrupt')
  const contents = FILES.map((file, index) => {
    const path = join(staging, file)
    regular(path)
    const text = readFileSync(path, 'utf8')
    if (createHash('sha256').update(text).digest('hex') !== journal.hashes[index])
      throw new VaultError('corrupt')
    return text
  })
  const [settingsText, sshText, manifestText] = contents
  if (settingsText === undefined || sshText === undefined || manifestText === undefined)
    throw new VaultError('corrupt')
  const manifest = decodeVaultManifest(manifestText)
  assertMigratedVaultStores(safeJsonParse(settingsText), safeJsonParse(sshText), manifest)
  for (const [index, file] of FILES.entries()) {
    const text = contents[index]
    if (text === undefined) throw new VaultError('corrupt')
    writeVaultFile(userData, file, text)
  }
  const completed = join(userData, `.vault-completed-${randomUUID()}`)
  renameSync(staging, completed)
  syncDirectory(userData)
  // Once the journal is retired, cleanup failure cannot make startup replay a
  // partially deleted staging directory. These leftovers contain ciphertext only.
  try {
    rmSync(completed, { recursive: true })
  } catch {
    /* Retryable housekeeping only. */
  }
  return true
}

/** Detect a missing/mismatched manifest before a legacy cipher can write a new key. */
export function assertVaultProfileState(userData: string): void {
  const settings = readVaultSource(userData, 'settings.json')
  const manifest = readVaultManifest(userData)
  const marker = settings['savedSecretEncryption']
  if (manifest) {
    const parsed = z
      .strictObject({
        version: z.literal(1),
        profileId: z.literal(manifest.profileId),
        keyId: z.literal(manifest.keyId),
      })
      .safeParse(marker)
    if (!parsed.success) throw new VaultError('corrupt')
    return
  }
  if (marker !== undefined) throw new VaultError('corrupt')
  const containsVaultRecord = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsVaultRecord)
    const parsed = objectSchema.safeParse(value)
    if (!parsed.success) return false
    if (
      typeof parsed.data['enc'] === 'string' &&
      Buffer.from(parsed.data['enc'], 'base64').subarray(0, 4).toString() === 'CPS3'
    )
      return true
    return Object.values(parsed.data).some(containsVaultRecord)
  }
  if (
    containsVaultRecord(settings) ||
    containsVaultRecord(readVaultSource(userData, 'ssh-credentials.json'))
  )
    throw new VaultError('corrupt')
}
