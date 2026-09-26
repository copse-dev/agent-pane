import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVaultManifest,
  newVaultIdentity,
  VaultError,
} from '@copse/store-kit/profile-vault-crypto.ts'
import {
  HeadlessVaultProfileError,
  joinSharedProfile,
  prepareOwnedProfile,
  profileStartupGuidance,
} from './profile-ownership.ts'

function withProfile(run: (path: string) => void): void {
  const path = mkdtempSync(join(tmpdir(), 'copse-profile-ownership-'))
  try {
    run(path)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}
function leases(path: string): string[] {
  const clients = join(path, '.vault-clients')
  return existsSync(clients) ? readdirSync(clients) : []
}
function seedManifest(path: string): void {
  const key = randomBytes(32)
  const manifest = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
  key.fill(0)
  writeFileSync(join(path, 'vault-manifest.json'), JSON.stringify(manifest))
  writeFileSync(
    join(path, 'settings.json'),
    JSON.stringify({
      savedSecretEncryption: { version: 1, profileId: manifest.profileId, keyId: manifest.keyId },
    }),
  )
}

describe('shared headless profile clients', () => {
  it('hold a lease on an ordinary profile until released', () => {
    withProfile((path) => {
      const release = joinSharedProfile(path)
      assert.equal(leases(path).length, 1)
      release()
      assert.deepEqual(leases(path), [])
    })
  })

  it('refuse a device-encrypted profile without leaving a lease behind', () => {
    withProfile((path) => {
      seedManifest(path)
      assert.throws(() => joinSharedProfile(path), HeadlessVaultProfileError)
      assert.deepEqual(leases(path), [])
    })
  })

  it('refuse to join while the desktop holds the maintenance gate', () => {
    withProfile((path) => {
      mkdirSync(join(path, '.vault-maintenance'))
      assert.throws(
        () => joinSharedProfile(path),
        (error: unknown) => error instanceof VaultError && error.reason === 'locked',
      )
      assert.deepEqual(leases(path), [])
    })
  })
})

describe('desktop profile owner', () => {
  it('retires a crashed owner gate and accepts a consistent vault profile', () => {
    withProfile((path) => {
      seedManifest(path)
      mkdirSync(join(path, '.vault-maintenance'))
      prepareOwnedProfile(path)
      assert.equal(existsSync(join(path, '.vault-maintenance')), false)
    })
  })

  it('refuses a marker whose manifest is missing', () => {
    withProfile((path) => {
      writeFileSync(
        join(path, 'settings.json'),
        JSON.stringify({
          savedSecretEncryption: { version: 1, profileId: randomUUID(), keyId: randomUUID() },
        }),
      )
      assert.throws(
        () => {
          prepareOwnedProfile(path)
        },
        (error: unknown) => error instanceof VaultError && error.reason === 'corrupt',
      )
    })
  })
})

describe('profile startup guidance', () => {
  it('explains each refusal instead of surfacing a raw error', () => {
    const profile = '/Users/me/.copse/user-data'
    assert.match(
      profileStartupGuidance(new VaultError('corrupt'), profile),
      /same backup.*Nothing was changed.*COPSE_DIR/s,
    )
    assert.match(
      profileStartupGuidance(new VaultError('locked'), profile),
      /desktop app is changing saved-secret encryption/,
    )
    assert.match(
      profileStartupGuidance(new HeadlessVaultProfileError(), profile),
      /separate profile \(COPSE_DIR\)/,
    )
    assert.match(
      profileStartupGuidance(new Error('EACCES: permission denied'), profile),
      /EACCES.*writable/,
    )
  })
})
