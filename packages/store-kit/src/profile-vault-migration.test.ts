import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeyringCipher } from './keyring-cipher.ts'
import {
  createVaultManifest,
  newVaultIdentity,
  openVaultRecord,
  VaultError,
  type VaultManifest,
} from './profile-vault-crypto.ts'
import { migrateVaultStores } from './profile-vault-migration.ts'
import {
  assertVaultProfileState,
  commitVaultMigration,
  readVaultManifest,
  recoverVaultMigration,
} from './profile-vault-files.ts'
import type { SecretCipher } from './secret-cipher.ts'

function fixture(): {
  key: Buffer
  manifest: VaultManifest
  legacy: SecretCipher
  sealed: { v: 1; enc: string }
  plain: { v: 1; enc: string; plain: true }
} {
  const key = randomBytes(32)
  const legacyKey = randomBytes(32).toString('base64')
  const legacy = createKeyringCipher({
    read: () => legacyKey,
    write: () => {
      throw new Error('must not replace legacy key')
    },
  })
  const manifest = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
  return {
    key,
    manifest,
    legacy,
    sealed: { v: 1, enc: legacy.encryptString('synthetic').toString('base64') },
    plain: { v: 1, enc: Buffer.from('plaintext-fixture').toString('base64'), plain: true },
  }
}
describe('profile vault migration', () => {
  it('migrates every registered secret namespace and preserves unrelated settings', () => {
    const { key, manifest, legacy, sealed, plain } = fixture()
    const settings = {
      theme: 'dark',
      apiKey: { openai: sealed, custom: plain },
      vncUsername: { target: sealed },
      vncPassword: { target: sealed },
    }
    const ssh = { hosts: { machine: { prompt: sealed } } }
    const originals = structuredClone({ settings, ssh })
    const result = migrateVaultStores(settings, ssh, legacy, key, manifest)
    assert.equal(result.count, 5)
    assert.equal(result.settings['theme'], 'dark')
    assert.deepEqual({ settings, ssh }, originals)
    const settingsText = JSON.stringify(result.settings)
    assert.ok(!settingsText.includes(plain.enc))
    assert.ok(!settingsText.includes(sealed.enc))
    const value: unknown = result.settings['apiKey']
    assert.ok(value && typeof value === 'object' && 'openai' in value)
    const record = value.openai
    assert.ok(
      record && typeof record === 'object' && 'enc' in record && typeof record.enc === 'string',
    )
    assert.equal(
      openVaultRecord(
        key,
        manifest,
        { store: 'api-key', record: 'openai' },
        Buffer.from(record.enc, 'base64'),
      ),
      'synthetic',
    )
  })
  it('aborts the whole inventory on corrupt or unreadable records without mutating source', () => {
    const { key, manifest, legacy, sealed } = fixture()
    for (const bad of [{ v: 1, enc: 'broken' }, { v: 7, enc: sealed.enc }, null]) {
      const settings = { apiKey: { good: sealed, bad } }
      const before = structuredClone(settings)
      assert.throws(() => migrateVaultStores(settings, {}, legacy, key, manifest), VaultError)
      assert.deepEqual(settings, before)
    }
    assert.throws(() => migrateVaultStores({ apiKey: [] }, {}, legacy, key, manifest), VaultError)
  })
  it('commits ciphertext and manifest, retaining all credential counts', () => {
    const { key, manifest, legacy, plain } = fixture()
    const directory = mkdtempSync(join(tmpdir(), 'copse-vault-'))
    try {
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({ apiKey: { openai: plain } }))
      const result = migrateVaultStores({ apiKey: { openai: plain } }, {}, legacy, key, manifest)
      commitVaultMigration(directory, result, manifest)
      assert.deepEqual(readVaultManifest(directory), manifest)
      assert.equal(
        readFileSync(join(directory, 'settings.json'), 'utf8'),
        JSON.stringify(result.settings),
      )
      assert.equal(recoverVaultMigration(directory), false)
      assert.throws(() => {
        commitVaultMigration(directory, result, manifest)
      }, VaultError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('replays after interruption at each live-file replacement boundary', () => {
    const { key, manifest, legacy, sealed } = fixture()
    const result = migrateVaultStores(
      { apiKey: { openai: sealed } },
      { hosts: { a: { p: sealed } } },
      legacy,
      key,
      manifest,
    )
    const contents = [
      JSON.stringify(result.settings),
      JSON.stringify(result.sshCredentials),
      JSON.stringify(manifest),
    ]
    const files = ['settings.json', 'ssh-credentials.json', 'vault-manifest.json']
    for (let written = 0; written <= 3; written++) {
      const directory = mkdtempSync(join(tmpdir(), 'copse-vault-replay-'))
      try {
        const staging = join(directory, '.vault-migration')
        mkdirSync(staging)
        for (const [index, file] of files.entries()) {
          const text = contents[index]
          assert.ok(text)
          writeFileSync(join(staging, file), text)
          if (index < written) writeFileSync(join(directory, file), text)
        }
        writeFileSync(
          join(staging, 'commit.json'),
          JSON.stringify({
            version: 1,
            hashes: contents.map((text) => createHash('sha256').update(text).digest('hex')),
          }),
        )
        assert.equal(recoverVaultMigration(directory), true)
        assert.deepEqual(readVaultManifest(directory), manifest)
        assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), contents[0])
        assert.equal(recoverVaultMigration(directory), false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
  it('rejects a symlink destination before replacing that file', () => {
    const { key, manifest, legacy, sealed } = fixture()
    const directory = mkdtempSync(join(tmpdir(), 'copse-vault-symlink-'))
    try {
      const outside = join(directory, 'untouched.json')
      writeFileSync(outside, 'original')
      symlinkSync(outside, join(directory, 'settings.json'))
      const result = migrateVaultStores({ apiKey: { openai: sealed } }, {}, legacy, key, manifest)
      assert.throws(() => {
        commitVaultMigration(directory, result, manifest)
      }, VaultError)
      assert.equal(readFileSync(outside, 'utf8'), 'original')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('vault startup downgrade prevention', () => {
  it('refuses missing or mismatched manifests before opening legacy stores', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-vault-marker-'))
    try {
      const { key, manifest, legacy, plain } = fixture()
      const migrated = migrateVaultStores({ apiKey: { openai: plain } }, {}, legacy, key, manifest)
      commitVaultMigration(directory, migrated, manifest)
      assert.doesNotThrow(() => {
        assertVaultProfileState(directory)
      })
      rmSync(join(directory, 'vault-manifest.json'))
      assert.throws(() => {
        assertVaultProfileState(directory)
      }, VaultError)
      delete migrated.settings['savedSecretEncryption']
      writeFileSync(join(directory, 'settings.json'), JSON.stringify(migrated.settings))
      assert.throws(() => {
        assertVaultProfileState(directory)
      }, VaultError)
      writeFileSync(join(directory, 'vault-manifest.json'), JSON.stringify(manifest))
      assert.throws(() => {
        assertVaultProfileState(directory)
      }, VaultError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
