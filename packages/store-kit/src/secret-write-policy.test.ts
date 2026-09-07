import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ALLOW_PLAINTEXT_SECRETS_ENV, resolveSecretWritePolicy } from './secret-write-policy.ts'

describe('resolveSecretWritePolicy', () => {
  it('uses encryption whenever it is available', () => {
    assert.equal(resolveSecretWritePolicy(true, false, {}), 'encrypted')
    assert.equal(
      resolveSecretWritePolicy(true, true, { [ALLOW_PLAINTEXT_SECRETS_ENV]: '1' }),
      'encrypted',
    )
  })

  it('disables plaintext persistence by default even after renderer consent', () => {
    assert.equal(resolveSecretWritePolicy(false, false, {}), 'plaintext-disabled')
    assert.equal(resolveSecretWritePolicy(false, true, {}), 'plaintext-disabled')
    assert.equal(
      resolveSecretWritePolicy(false, true, { [ALLOW_PLAINTEXT_SECRETS_ENV]: 'true' }),
      'plaintext-disabled',
    )
  })

  it('requires per-save consent after the environment escape hatch is enabled', () => {
    const env = { [ALLOW_PLAINTEXT_SECRETS_ENV]: '1' }
    assert.equal(resolveSecretWritePolicy(false, false, env), 'plaintext-consent-required')
    assert.equal(resolveSecretWritePolicy(false, true, env), 'plaintext-approved')
  })
})
