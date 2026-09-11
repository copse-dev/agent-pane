/** Authenticated per-profile records. OS authorization and persistence live outside this module. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

const MAGIC = Buffer.from('CPS3')
const MAX_SECRET_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024
const ID = z.uuid().regex(/^[a-f0-9-]+$/)
const BASE64 = z
  .string()
  .max(8192)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const manifestSchema = z.strictObject({
  version: z.literal(1),
  profileId: ID,
  keyId: ID,
  deviceKeyId: ID,
  deviceEnvelope: BASE64.min(1),
  recovery: z.enum(['not-backed-up', 'verified']),
  challenge: BASE64.min(1),
  mac: BASE64,
})
export type VaultManifest = z.infer<typeof manifestSchema>
export type VaultIdentity = Pick<VaultManifest, 'profileId' | 'keyId'>
export interface SecretRecordIdentity {
  store: 'api-key' | 'ssh' | 'vnc-username' | 'vnc-password' | 'vault-challenge'
  record: string
}
export type VaultFailure =
  | 'locked'
  | 'cancelled'
  | 'unavailable'
  | 'corrupt'
  | 'unsupported'
  | 'recovery-required'
export class VaultError extends Error {
  readonly reason: VaultFailure
  constructor(reason: VaultFailure) {
    super(`Saved-secret vault: ${reason}`)
    this.name = 'VaultError'
    this.reason = reason
  }
}

function validateKey(key: Buffer): void {
  if (key.length !== 32) throw new VaultError('corrupt')
}
function validateIdentity(identity: VaultIdentity): void {
  if (!ID.safeParse(identity.profileId).success || !ID.safeParse(identity.keyId).success) {
    throw new VaultError('corrupt')
  }
}
function aad(identity: VaultIdentity, record: SecretRecordIdentity): Buffer {
  validateIdentity(identity)
  if (!record.record || Buffer.byteLength(record.record) > 4096) throw new VaultError('corrupt')
  return Buffer.from(
    JSON.stringify(['CPS3', identity.profileId, identity.keyId, record.store, record.record]),
  )
}

/** No format sniffing or legacy fallback: a vault record must be CPS3. */
export function sealVaultRecord(
  key: Buffer,
  identity: VaultIdentity,
  record: SecretRecordIdentity,
  value: string,
): Buffer {
  validateKey(key)
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new VaultError('corrupt')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(identity, record))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([
    MAGIC,
    Buffer.from(identity.profileId),
    Buffer.from(identity.keyId),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ])
}
export function openVaultRecord(
  key: Buffer,
  identity: VaultIdentity,
  record: SecretRecordIdentity,
  encrypted: Buffer,
): string {
  validateKey(key)
  validateIdentity(identity)
  if (
    encrypted.length < 104 ||
    encrypted.length > 104 + MAX_SECRET_BYTES ||
    !encrypted.subarray(0, 4).equals(MAGIC)
  ) {
    throw new VaultError('corrupt')
  }
  if (
    encrypted.toString('utf8', 4, 40) !== identity.profileId ||
    encrypted.toString('utf8', 40, 76) !== identity.keyId
  ) {
    throw new VaultError('corrupt')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(76, 88))
    decipher.setAAD(aad(identity, record))
    decipher.setAuthTag(encrypted.subarray(88, 104))
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(104)), decipher.final()])
    try {
      return plaintext.toString('utf8')
    } finally {
      plaintext.fill(0)
    }
  } catch {
    throw new VaultError('corrupt')
  }
}

function manifestPayload(manifest: VaultManifest): string {
  return JSON.stringify([
    manifest.version,
    manifest.profileId,
    manifest.keyId,
    manifest.deviceKeyId,
    manifest.deviceEnvelope,
    manifest.recovery,
    manifest.challenge,
  ])
}
function manifestMac(key: Buffer, manifest: VaultManifest): Buffer {
  validateKey(key)
  const authKey = Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.from(manifest.profileId),
      Buffer.from('copse-vault-manifest-v1'),
      32,
    ),
  )
  try {
    return createHmac('sha256', authKey).update(manifestPayload(manifest)).digest()
  } finally {
    authKey.fill(0)
  }
}
export function authenticateManifest(key: Buffer, manifest: VaultManifest): VaultManifest {
  manifestSchema.parse(manifest)
  return { ...manifest, mac: manifestMac(key, manifest).toString('base64') }
}
export function verifyManifest(key: Buffer, manifest: VaultManifest): void {
  if (!manifestSchema.safeParse(manifest).success) throw new VaultError('corrupt')
  const mac = Buffer.from(manifest.mac, 'base64')
  const expected = manifestMac(key, manifest)
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected))
    throw new VaultError('corrupt')
  const challenge = openVaultRecord(
    key,
    manifest,
    { store: 'vault-challenge', record: 'unlock' },
    Buffer.from(manifest.challenge, 'base64'),
  )
  if (challenge !== 'copse-vault-challenge-v1') throw new VaultError('corrupt')
}
export function newVaultIdentity(): VaultIdentity {
  return { profileId: randomUUID(), keyId: randomUUID() }
}
export function createVaultManifest(
  key: Buffer,
  identity: VaultIdentity,
  deviceKeyId: string,
  deviceEnvelope: string,
): VaultManifest {
  const manifest: VaultManifest = {
    version: 1,
    ...identity,
    deviceKeyId,
    deviceEnvelope,
    recovery: 'not-backed-up',
    challenge: sealVaultRecord(
      key,
      identity,
      { store: 'vault-challenge', record: 'unlock' },
      'copse-vault-challenge-v1',
    ).toString('base64'),
    mac: '',
  }
  return authenticateManifest(key, manifest)
}
/** Canonical JSON also rejects duplicate properties and ambiguous serialized metadata. */
export function decodeVaultManifest(text: string): VaultManifest {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new VaultError('corrupt')
  const manifest = safeJsonParse(text, decodeWithSchema(manifestSchema))
  if (!manifest || JSON.stringify(manifest) !== text) throw new VaultError('corrupt')
  return manifest
}

const RECOVERY_PREFIX = 'COPSE-RECOVERY-1.'
/** Native UI only. Never expose this result to renderer settings, logs, or files. */
export function encodeRecoveryRecord(key: Buffer, identity: VaultIdentity): string {
  validateKey(key)
  validateIdentity(identity)
  const payload = Buffer.concat([Buffer.from(identity.profileId), Buffer.from(identity.keyId), key])
  try {
    const checksum = createHash('sha256')
      .update(RECOVERY_PREFIX)
      .update(payload)
      .digest('hex')
      .slice(0, 16)
    return `${RECOVERY_PREFIX}${payload.toString('base64url')}.${checksum}`
  } finally {
    payload.fill(0)
  }
}
/** Caller owns and must zero the returned key. Verification of the manifest is mandatory. */
export function decodeRecoveryRecord(text: string, identity: VaultIdentity): Buffer {
  validateIdentity(identity)
  const trimmed = text.trim()
  if (trimmed.length !== RECOVERY_PREFIX.length + 139 + 17 || !trimmed.startsWith(RECOVERY_PREFIX))
    throw new VaultError('corrupt')
  const encoded = trimmed.slice(RECOVERY_PREFIX.length, -17)
  if (!/^[A-Za-z0-9_-]{139}$/.test(encoded)) throw new VaultError('corrupt')
  const payload = Buffer.from(encoded, 'base64url')
  try {
    if (
      payload.length !== 104 ||
      payload.toString('base64url') !== encoded ||
      payload.toString('utf8', 0, 36) !== identity.profileId ||
      payload.toString('utf8', 36, 72) !== identity.keyId
    )
      throw new VaultError('corrupt')
    const checksum = createHash('sha256')
      .update(RECOVERY_PREFIX)
      .update(payload)
      .digest('hex')
      .slice(0, 16)
    if (trimmed.slice(-17) !== `.${checksum}`) throw new VaultError('corrupt')
    return Buffer.from(payload.subarray(72))
  } finally {
    payload.fill(0)
  }
}
