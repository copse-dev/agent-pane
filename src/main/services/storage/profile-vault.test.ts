import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVaultManifest,
  newVaultIdentity,
  verifyManifest,
  VaultError,
} from '@copse/store-kit/profile-vault-crypto.ts'
import { readVaultManifest } from '@copse/store-kit/profile-vault-files.ts'
import type { NativeVaultRequest, NativeVaultReply } from '@copse/store-kit/profile-vault-native.ts'
import { AppProfileVault } from './profile-vault.ts'
import type { SecretCipher } from './secret-cipher.ts'

const legacy: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text),
  decryptString: (bytes) => bytes.toString(),
}
function fixture(): { path: string; key: Buffer; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'copse-vault-service-'))
  return {
    path,
    key: randomBytes(32),
    dispose: (): void => {
      rmSync(path, { recursive: true, force: true })
    },
  }
}
describe('application vault', () => {
  it('commits every legacy secret, starts locked, and authenticates automatically on normal restart', async () => {
    const f = fixture()
    const calls: string[] = []
    let restarts = 0
    const invoke = async (request: NativeVaultRequest): Promise<NativeVaultReply> => {
      calls.push(request.operation)
      return request.operation === 'status'
        ? { ok: true }
        : {
            ok: true,
            dataKey: f.key.toString('base64'),
            deviceKeyId: randomUUID(),
            deviceEnvelope: Buffer.from('synthetic envelope').toString('base64'),
          }
    }
    try {
      writeFileSync(
        join(f.path, 'settings.json'),
        JSON.stringify({
          apiKey: {
            openai: { v: 1, enc: Buffer.from('synthetic api key').toString('base64'), plain: true },
          },
        }),
      )
      const deps = {
        userData: f.path,
        legacy,
        invoke,
        beforeMigration: async (): Promise<void> => {},
        restart: (): void => {
          restarts++
        },
      }
      const vault = new AppProfileVault(deps)
      await vault.enable(false)
      assert.equal(restarts, 1)
      assert.equal(vault.cipher.isEncryptionAvailable(), false)
      assert.equal((await vault.status()).recovery, 'not-backed-up')
      const manifest = readVaultManifest(f.path)
      assert.ok(manifest)
      verifyManifest(f.key, manifest)
      assert.ok(
        !readFileSync(join(f.path, 'settings.json'), 'utf8').includes(
          Buffer.from('synthetic api key').toString('base64'),
        ),
      )
      const restarted = new AppProfileVault(deps)
      assert.throws(
        () => restarted.cipher.encryptString('secret', { store: 'api-key', record: 'openai' }),
        VaultError,
      )
      await Promise.all([restarted.unlockOnStartup(), restarted.unlockOnStartup()])
      await restarted.unlockOnStartup()
      const record = { store: 'api-key', record: 'openai' } as const
      const sealed = restarted.cipher.encryptString('roundtrip', record)
      assert.equal(restarted.cipher.decryptString(sealed, record), 'roundtrip')
      restarted.lock()
      assert.throws(() => restarted.cipher.decryptString(sealed, record), VaultError)
      assert.equal(restarts, 2)
      assert.deepEqual(calls, ['create', 'status', 'unlock'])
      restarted.dispose()
    } finally {
      f.dispose()
    }
  })
  it('does not enroll or authenticate a legacy profile on startup', async () => {
    const f = fixture()
    try {
      const vault = new AppProfileVault({
        userData: f.path,
        legacy,
        beforeMigration: async (): Promise<void> => {},
        restart: (): void => assert.fail('unexpected restart'),
        invoke: async (): Promise<NativeVaultReply> => assert.fail('unexpected native request'),
      })
      await vault.unlockOnStartup()
      assert.equal(vault.cipher.protection, undefined)
      assert.equal(readVaultManifest(f.path), null)
      vault.dispose()
    } finally {
      f.dispose()
    }
  })
  it('does not automatically retry cancelled startup authentication but allows explicit Unlock', async () => {
    const f = fixture()
    let attempts = 0
    try {
      writeFileSync(
        join(f.path, 'vault-manifest.json'),
        JSON.stringify(
          createVaultManifest(f.key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj'),
        ),
      )
      const vault = new AppProfileVault({
        userData: f.path,
        legacy,
        beforeMigration: async (): Promise<void> => {},
        restart: (): void => assert.fail('unexpected restart'),
        invoke: async (): Promise<NativeVaultReply> => {
          if (++attempts === 1) throw new VaultError('cancelled')
          return { ok: true, dataKey: f.key.toString('base64') }
        },
      })
      await assert.rejects(vault.unlockOnStartup(), { reason: 'cancelled' })
      await assert.rejects(vault.unlockOnStartup(), { reason: 'cancelled' })
      assert.equal(attempts, 1)
      assert.equal(vault.cipher.isEncryptionAvailable(), false)
      await vault.unlock()
      assert.equal(attempts, 2)
      assert.equal(vault.cipher.isEncryptionAvailable(), true)
      vault.dispose()
      assert.equal(vault.cipher.isEncryptionAvailable(), false)
    } finally {
      f.dispose()
    }
  })
  it('cancelling mandatory backup leaves all original files unchanged', async () => {
    const f = fixture()
    try {
      const original = JSON.stringify({ arbitrary: 'unchanged' })
      writeFileSync(join(f.path, 'settings.json'), original)
      const vault = new AppProfileVault({
        userData: f.path,
        legacy,
        beforeMigration: async (): Promise<void> => {},
        restart: (): void => {
          assert.fail('must not restart')
        },
        invoke: async (request): Promise<NativeVaultReply> => {
          if (request.operation === 'backup') throw new VaultError('cancelled')
          return {
            ok: true,
            dataKey: f.key.toString('base64'),
            deviceKeyId: randomUUID(),
            deviceEnvelope: 'c3ludGhldGlj',
          }
        },
      })
      await assert.rejects(vault.enable(true), { reason: 'cancelled' })
      assert.equal(readVaultManifest(f.path), null)
      assert.equal(readFileSync(join(f.path, 'settings.json'), 'utf8'), original)
      assert.equal(vault.cipher.protection, undefined)
    } finally {
      f.dispose()
    }
  })
  it('rejects a wrong recovery key without changing the original envelope', async () => {
    const f = fixture()
    try {
      const manifest = createVaultManifest(f.key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
      const original = JSON.stringify(manifest)
      writeFileSync(join(f.path, 'vault-manifest.json'), original)
      const vault = new AppProfileVault({
        userData: f.path,
        legacy,
        beforeMigration: async (): Promise<void> => {},
        restart: (): void => {
          assert.fail('must not restart')
        },
        invoke: async (): Promise<NativeVaultReply> => ({
          ok: true,
          dataKey: randomBytes(32).toString('base64'),
          deviceKeyId: randomUUID(),
          deviceEnvelope: 'c3ludGhldGlj',
        }),
      })
      await assert.rejects(vault.recover(), VaultError)
      assert.equal(readFileSync(join(f.path, 'vault-manifest.json'), 'utf8'), original)
      assert.equal(vault.cipher.isEncryptionAvailable(), false)
    } finally {
      f.dispose()
    }
  })
})
