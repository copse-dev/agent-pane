import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VaultError } from '@copse/store-kit/profile-vault-crypto.ts'
import { unlessVaultLocked } from './vault-locked.ts'

describe('unlessVaultLocked', () => {
  it('returns the read value when the vault is open', () => {
    assert.equal(
      unlessVaultLocked(() => 'key', null),
      'key',
    )
  })

  it('treats a locked vault as the fallback value', () => {
    assert.equal(
      unlessVaultLocked(() => {
        throw new VaultError('locked')
      }, null),
      null,
    )
  })

  it('propagates every other failure', () => {
    assert.throws(
      () =>
        unlessVaultLocked(() => {
          throw new VaultError('corrupt')
        }, null),
      (error: unknown) => error instanceof VaultError && error.reason === 'corrupt',
    )
    assert.throws(
      () =>
        unlessVaultLocked(() => {
          throw new Error('disk')
        }, null),
      /disk/,
    )
  })
})
