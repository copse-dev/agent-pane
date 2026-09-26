import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { ProfileVaultSession } from './profile-vault-session.ts'
import {
  createVaultManifest,
  newVaultIdentity,
  VaultError,
  type VaultManifest,
} from './profile-vault-crypto.ts'

function fixture(): { key: Buffer; manifest: VaultManifest } {
  const key = randomBytes(32)
  const manifest = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
  return { key, manifest }
}
describe('profile vault session', () => {
  it('starts locked, coalesces explicit unlock and clears backend-owned buffers', async () => {
    const { key, manifest } = fixture()
    let calls = 0
    const buffer = Buffer.from(key)
    const session = new ProfileVaultSession(manifest, {
      unlock: async (): Promise<Buffer> => {
        calls++
        return buffer
      },
    })
    assert.equal(session.status, 'locked')
    assert.equal(calls, 0)
    assert.throws(() => session.encrypt('x', { store: 'api-key', record: 'openai' }), VaultError)
    const a = session.unlock()
    assert.equal(session.status, 'unlocking')
    assert.equal(a, session.unlock())
    await a
    assert.equal(calls, 1)
    assert.deepEqual(buffer, Buffer.alloc(32))
    const identity = { store: 'api-key', record: 'openai' } as const
    const encrypted = session.encrypt('synthetic', identity)
    assert.equal(session.decrypt(encrypted, identity), 'synthetic')
    session.lock()
    assert.equal(session.status, 'locked')
    assert.throws(() => session.decrypt(encrypted, identity), VaultError)
    assert.equal(calls, 1)
  })
  it('ignores and clears a late unlock even if its backend ignores cancellation', async () => {
    const { key, manifest } = fixture()
    const deferred = Promise.withResolvers<Buffer>()
    let signal: AbortSignal | undefined
    const session = new ProfileVaultSession(manifest, {
      unlock: (current): Promise<Buffer> => {
        signal = current
        return deferred.promise
      },
    })
    const pending = session.unlock()
    await Promise.resolve()
    session.lock()
    assert.equal(signal?.aborted, true)
    const late = Buffer.from(key)
    deferred.resolve(late)
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof VaultError && error.reason === 'cancelled',
    )
    assert.equal(session.status, 'locked')
    assert.deepEqual(late, Buffer.alloc(32))
  })
  it('keeps a new unlock separate from completion of the cancelled generation', async () => {
    const { key, manifest } = fixture()
    const first = Promise.withResolvers<Buffer>()
    const second = Promise.withResolvers<Buffer>()
    let calls = 0
    const session = new ProfileVaultSession(manifest, {
      unlock: (): Promise<Buffer> => (++calls === 1 ? first.promise : second.promise),
    })
    const old = session.unlock()
    await Promise.resolve()
    session.lock()
    const current = session.unlock()
    await Promise.resolve()
    first.resolve(Buffer.from(key))
    await assert.rejects(old, VaultError)
    assert.equal(session.status, 'unlocking')
    second.resolve(Buffer.from(key))
    await current
    assert.equal(session.status, 'unlocked')
    session.lock()
  })
  it('rejects wrong recovered keys without changing the manifest or unlocking', async () => {
    const { manifest } = fixture()
    const original = structuredClone(manifest)
    const wrong = randomBytes(32)
    const session = new ProfileVaultSession(manifest, {
      unlock: async (): Promise<Buffer> => wrong,
    })
    await assert.rejects(session.unlock(), VaultError)
    assert.equal(session.status, 'locked')
    assert.deepEqual(wrong, Buffer.alloc(32))
    assert.deepEqual(manifest, original)
  })
})
