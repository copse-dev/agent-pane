import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  type VaultIdentity,
  type VaultManifest,
  authenticateManifest,
  createVaultManifest,
  decodeRecoveryRecord,
  decodeVaultManifest,
  encodeRecoveryRecord,
  newVaultIdentity,
  openVaultRecord,
  sealVaultRecord,
  verifyManifest,
  VaultError,
} from './profile-vault-crypto.ts'

const record = { store: 'api-key', record: 'openai' } as const
function fixture(): { key: Buffer; identity: VaultIdentity; manifest: VaultManifest } {
  const key = randomBytes(32)
  const identity = newVaultIdentity()
  const manifest = createVaultManifest(
    key,
    identity,
    randomUUID(),
    randomBytes(120).toString('base64'),
  )
  return { key, identity, manifest }
}
describe('profile vault cryptography', () => {
  it('round trips Unicode and empty records with fresh nonces', () => {
    const { key, identity } = fixture()
    for (const text of ['', 'synthetic-🔐-\u0000-secret']) {
      const first = sealVaultRecord(key, identity, record, text)
      const second = sealVaultRecord(key, identity, record, text)
      assert.notDeepEqual(first, second)
      assert.equal(openVaultRecord(key, identity, record, first), text)
    }
  })
  it('binds ciphertext to the key, profile, generation, store and record slot', () => {
    const { key, identity } = fixture()
    const encrypted = sealVaultRecord(key, identity, record, 'synthetic secret')
    const cases: (() => string)[] = [
      (): string => openVaultRecord(randomBytes(32), identity, record, encrypted),
      (): string =>
        openVaultRecord(key, { ...identity, profileId: randomUUID() }, record, encrypted),
      (): string => openVaultRecord(key, { ...identity, keyId: randomUUID() }, record, encrypted),
      (): string => openVaultRecord(key, identity, { ...record, store: 'ssh' }, encrypted),
      (): string => openVaultRecord(key, identity, { ...record, record: 'anthropic' }, encrypted),
    ]
    for (const operation of cases) assert.throws(operation, VaultError)
  })
  it('rejects tampering in every byte, truncated records and legacy formats', () => {
    const { key, identity } = fixture()
    const encrypted = sealVaultRecord(key, identity, record, 'synthetic secret')
    for (const mask of [1, 128]) {
      for (let offset = 0; offset < encrypted.length; offset++) {
        const tampered = Buffer.from(encrypted)
        tampered.writeUInt8(tampered.readUInt8(offset) ^ mask, offset)
        assert.throws((): string => openVaultRecord(key, identity, record, tampered), VaultError)
      }
    }
    for (const bytes of [
      encrypted.subarray(0, -1),
      Buffer.alloc(0),
      Buffer.from('CPS2'),
      Buffer.alloc(104 + 1024 * 1024 + 1),
    ]) {
      assert.throws((): string => openVaultRecord(key, identity, record, bytes), VaultError)
    }
    assert.throws(
      () => sealVaultRecord(key, identity, record, 'x'.repeat(1024 * 1024 + 1)),
      VaultError,
    )
  })
  it('authenticates manifest enrollment, recovery status and empty-vault challenge', () => {
    const { key, manifest } = fixture()
    verifyManifest(key, manifest)
    verifyManifest(key, authenticateManifest(key, { ...manifest, recovery: 'verified' }))
    for (const changed of [
      { ...manifest, deviceKeyId: randomUUID() },
      { ...manifest, deviceEnvelope: randomBytes(120).toString('base64') },
      { ...manifest, recovery: 'verified' as const },
      { ...manifest, challenge: manifest.challenge.slice(4) },
    ])
      assert.throws(() => {
        verifyManifest(key, changed)
      }, VaultError)
    assert.throws(() => {
      verifyManifest(randomBytes(32), manifest)
    }, VaultError)
  })
  it('strictly decodes manifest version, shape, bounds and duplicate properties', () => {
    const { manifest } = fixture()
    const text = JSON.stringify(manifest)
    assert.deepEqual(decodeVaultManifest(text), manifest)
    for (const invalid of [
      '{',
      'null',
      '{}',
      JSON.stringify({ ...manifest, version: 2 }),
      JSON.stringify({ ...manifest, unexpected: true }),
      text.replace('{', '{"version":1,'),
      JSON.stringify({ ...manifest, deviceEnvelope: 'x'.repeat(17000) }),
    ])
      assert.throws(() => decodeVaultManifest(invalid), VaultError)
  })
  it('recovers the matching key and rejects wrong profiles, generations and transcription errors', () => {
    const { key, identity, manifest } = fixture()
    const recovery = encodeRecoveryRecord(key, identity)
    const recovered = decodeRecoveryRecord(recovery, identity)
    assert.deepEqual(recovered, key)
    verifyManifest(recovered, manifest)
    recovered.fill(0)
    assert.throws(
      () => decodeRecoveryRecord(recovery, { ...identity, keyId: randomUUID() }),
      VaultError,
    )
    assert.throws(
      () => decodeRecoveryRecord(recovery, { ...identity, profileId: randomUUID() }),
      VaultError,
    )
    assert.throws(() => decodeRecoveryRecord(recovery.slice(0, -1), identity), VaultError)
    assert.throws(() => decodeRecoveryRecord(recovery + 'x', identity), VaultError)
    assert.throws(
      () =>
        decodeRecoveryRecord(recovery.replace('COPSE-RECOVERY-1.', 'COPSE-RECOVERY-2.'), identity),
      VaultError,
    )
    const wrongKey = decodeRecoveryRecord(encodeRecoveryRecord(randomBytes(32), identity), identity)
    assert.throws(() => {
      verifyManifest(wrongKey, manifest)
    }, VaultError)
    wrongKey.fill(0)
  })
})
