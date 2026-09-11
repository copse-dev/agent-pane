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
  type VaultManifest,
} from '@copse/store-kit/profile-vault-crypto.ts'
import { readVaultManifest } from '@copse/store-kit/profile-vault-files.ts'
import type { NativeVaultRequest, NativeVaultReply } from '@copse/store-kit/profile-vault-native.ts'
import { AppProfileVault, type ProfileVaultDependencies } from './profile-vault.ts'
import type { SecretCipher } from './secret-cipher.ts'

const legacy: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text),
  decryptString: (bytes) => bytes.toString(),
}
function fixture(): {
  path: string
  key: Buffer
  calls: NativeVaultRequest[]
  deps: ProfileVaultDependencies
  restarts: () => number
  seed: () => VaultManifest
  dispose: () => void
} {
  const path = mkdtempSync(join(tmpdir(), 'copse-vault-service-'))
  const key = randomBytes(32)
  const calls: NativeVaultRequest[] = []
  let deviceKeyId = randomUUID()
  let requireAuth = false
  let restarts = 0
  const invoke = async (request: NativeVaultRequest): Promise<NativeVaultReply> => {
    calls.push(request)
    if (request.operation === 'status') return { ok: true, automatic: true, requireAuth }
    if (request.operation === 'set-auth') {
      requireAuth = request.requireAuth ?? true
      deviceKeyId = randomUUID()
    }
    return {
      ok: true,
      dataKey: key.toString('base64'),
      deviceKeyId,
      deviceEnvelope: Buffer.from('synthetic envelope').toString('base64'),
      requireAuth,
      ...(request.operation === 'backup' ? { recoveryVerified: true } : {}),
    }
  }
  const deps = {
    userData: path,
    legacy,
    invoke,
    beforeMigration: async (): Promise<void> => {},
    restart: (): void => {
      restarts++
    },
  }
  return {
    path,
    key,
    calls,
    deps,
    restarts: (): number => restarts,
    seed: (): VaultManifest => {
      const manifest = createVaultManifest(
        key,
        newVaultIdentity(),
        deviceKeyId,
        Buffer.from('synthetic envelope').toString('base64'),
      )
      writeFileSync(join(path, 'vault-manifest.json'), JSON.stringify(manifest))
      return manifest
    },
    dispose: (): void => {
      key.fill(0)
      rmSync(path, { recursive: true, force: true })
    },
  }
}

describe('application vault', () => {
  it('automatically migrates every saved credential before startup and silently opens on restart', async () => {
    const f = fixture()
    try {
      writeFileSync(
        join(f.path, 'settings.json'),
        JSON.stringify({
          apiKey: {
            openai: { v: 1, enc: Buffer.from('synthetic api key').toString('base64'), plain: true },
          },
        }),
      )
      const vault = new AppProfileVault(f.deps)
      assert.deepEqual(await Promise.all([vault.initialize(), vault.initialize()]), [true, true])
      assert.equal(f.restarts(), 1)
      assert.equal(f.calls.filter((call) => call.operation === 'create').length, 1)
      const manifest = readVaultManifest(f.path)
      assert.ok(manifest)
      verifyManifest(f.key, manifest)
      assert.equal(manifest.requireAuth, false)
      assert.ok(
        !readFileSync(join(f.path, 'settings.json'), 'utf8').includes(
          Buffer.from('synthetic api key').toString('base64'),
        ),
      )
      const restarted = new AppProfileVault(f.deps)
      assert.equal(await restarted.initialize(), false)
      assert.equal(restarted.cipher.isEncryptionAvailable(), true)
      const identity = { store: 'api-key', record: 'openai' } as const
      const sealed = restarted.cipher.encryptString('roundtrip', identity)
      assert.equal(restarted.cipher.decryptString(sealed, identity), 'roundtrip')
      restarted.dispose()
      assert.throws(() => restarted.cipher.decryptString(sealed, identity), VaultError)
    } finally {
      f.dispose()
    }
  })
  it('enrolls an empty new profile without a setup choice or recovery export', async () => {
    const f = fixture()
    try {
      assert.equal(await new AppProfileVault(f.deps).initialize(), true)
      assert.equal(readVaultManifest(f.path)?.requireAuth, false)
      assert.equal(readVaultManifest(f.path)?.recovery, 'not-backed-up')
      assert.ok(!f.calls.some((call) => call.operation === 'backup'))
    } finally {
      f.dispose()
    }
  })
  it('keeps unsupported or development profiles on existing storage without enrollment prompts', async () => {
    const f = fixture()
    try {
      const calls: string[] = []
      const vault = new AppProfileVault({
        ...f.deps,
        invoke: async (request): Promise<NativeVaultReply> => {
          calls.push(request.operation)
          return { ok: true, automatic: false }
        },
      })
      assert.equal(await vault.initialize(), false)
      assert.equal(vault.cipher.protection, undefined)
      assert.equal(readVaultManifest(f.path), null)
      assert.deepEqual(calls, ['status'])
    } finally {
      f.dispose()
    }
  })
  it('preserves unreadable source records on failed automatic migration and reports retry guidance', async () => {
    const f = fixture()
    try {
      const original = JSON.stringify({ apiKey: { openai: { broken: true } } })
      writeFileSync(join(f.path, 'settings.json'), original)
      const vault = new AppProfileVault(f.deps)
      await assert.rejects(vault.initialize())
      await assert.rejects(vault.initialize())
      assert.equal(readVaultManifest(f.path), null)
      assert.equal(readFileSync(join(f.path, 'settings.json'), 'utf8'), original)
      assert.equal((await vault.status()).migrationFailed, true)
      assert.equal(f.restarts(), 0)
      assert.equal(f.calls.filter((call) => call.operation === 'create').length, 1)
    } finally {
      f.dispose()
    }
  })
  it('changes authentication without re-encrypting records and always delegates backup authentication to native', async () => {
    const f = fixture()
    try {
      f.seed()
      const vault = new AppProfileVault(f.deps)
      await vault.initialize()
      const before = readVaultManifest(f.path)
      const identity = { store: 'api-key', record: 'openai' } as const
      const secret = vault.cipher.encryptString('synthetic', identity)
      await vault.setRequireAuth(true)
      const after = readVaultManifest(f.path)
      assert.equal(after?.keyId, before?.keyId)
      assert.notEqual(after?.deviceKeyId, before?.deviceKeyId)
      assert.equal(after?.requireAuth, true)
      assert.equal(vault.cipher.decryptString(secret, identity), 'synthetic')
      assert.equal(vault.cipher.isEncryptionAvailable(), true)
      const start = f.calls.length
      await vault.backup()
      assert.deepEqual(
        f.calls.slice(start).map((call) => call.operation),
        ['backup'],
      )
      assert.equal(readVaultManifest(f.path)?.recovery, 'verified')
      await vault.setRequireAuth(false)
      assert.equal(readVaultManifest(f.path)?.requireAuth, false)
      assert.equal(f.restarts(), 0)
      vault.dispose()
    } finally {
      f.dispose()
    }
  })
  it('repairs the manifest after native policy committed but the reply was lost', async () => {
    const f = fixture()
    try {
      f.seed()
      const vault = new AppProfileVault({
        ...f.deps,
        invoke: async (request): Promise<NativeVaultReply> => {
          const reply = await f.deps.invoke(request)
          if (request.operation === 'set-auth') throw new VaultError('unavailable')
          return reply
        },
      })
      await vault.initialize()
      const original = readVaultManifest(f.path)
      await assert.rejects(vault.setRequireAuth(true))
      assert.equal(readVaultManifest(f.path)?.requireAuth, false)
      assert.equal((await vault.status()).requireAuth, true)
      vault.dispose()
      const restarted = new AppProfileVault(f.deps)
      await restarted.initialize()
      const repaired = readVaultManifest(f.path)
      assert.equal(repaired?.requireAuth, true)
      assert.equal(repaired.keyId, original?.keyId)
      assert.notEqual(repaired.deviceKeyId, original?.deviceKeyId)
      restarted.dispose()
    } finally {
      f.dispose()
    }
  })
  it('does not automatically retry cancelled startup authentication but permits explicit Unlock', async () => {
    const f = fixture()
    let attempts = 0
    try {
      f.seed()
      const vault = new AppProfileVault({
        ...f.deps,
        invoke: async (request): Promise<NativeVaultReply> => {
          if (++attempts === 1) throw new VaultError('cancelled')
          return f.deps.invoke(request)
        },
      })
      await assert.rejects(vault.initialize(), { reason: 'cancelled' })
      await assert.rejects(vault.initialize(), { reason: 'cancelled' })
      assert.equal(attempts, 1)
      assert.equal(vault.cipher.isEncryptionAvailable(), false)
      await vault.unlock()
      assert.equal(attempts, 2)
      assert.equal(vault.cipher.isEncryptionAvailable(), true)
      vault.dispose()
    } finally {
      f.dispose()
    }
  })
  it('preserves existing vault authentication and leaves policy unchanged when native auth is cancelled', async () => {
    const f = fixture()
    try {
      f.seed()
      const vault = new AppProfileVault({
        ...f.deps,
        invoke: async (request): Promise<NativeVaultReply> => {
          if (request.operation === 'set-auth' || request.operation === 'backup')
            throw new VaultError('cancelled')
          return { ...(await f.deps.invoke(request)), requireAuth: true }
        },
      })
      await vault.initialize()
      const before = readFileSync(join(f.path, 'vault-manifest.json'), 'utf8')
      assert.equal(readVaultManifest(f.path)?.requireAuth, true)
      await assert.rejects(vault.setRequireAuth(false), { reason: 'cancelled' })
      await assert.rejects(vault.backup(), { reason: 'cancelled' })
      assert.equal(readFileSync(join(f.path, 'vault-manifest.json'), 'utf8'), before)
      assert.equal(vault.cipher.isEncryptionAvailable(), true)
      assert.ok(!f.calls.some((call) => call.operation === 'create'))
      vault.dispose()
    } finally {
      f.dispose()
    }
  })
  it('rejects a wrong recovery key without changing the profile manifest', async () => {
    const f = fixture()
    try {
      f.seed()
      const original = readFileSync(join(f.path, 'vault-manifest.json'), 'utf8')
      const vault = new AppProfileVault({
        ...f.deps,
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
