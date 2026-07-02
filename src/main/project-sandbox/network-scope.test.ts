import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containedSandboxNetworkConfig } from './config.ts'
import { acquireSandboxNetworkScope, mergedScopeNetwork } from './network-scope.ts'

describe('mergedScopeNetwork', () => {
  it('is the contained deny-all base with no active scopes', () => {
    assert.deepEqual(mergedScopeNetwork([]), containedSandboxNetworkConfig())
  })

  it('unions domains and ORs local binding across scopes', () => {
    const merged = mergedScopeNetwork([
      { domains: ['anthropic.com', '*.anthropic.com'], allowLocalBinding: false },
      { domains: ['*.googleapis.com', 'anthropic.com'], allowLocalBinding: true },
    ])
    assert.deepEqual([...merged.allowedDomains].sort(), [
      '*.anthropic.com',
      '*.googleapis.com',
      'anthropic.com',
    ])
    assert.equal(merged.allowLocalBinding, true)
    assert.deepEqual(merged.deniedDomains, [])
  })
})

describe('acquireSandboxNetworkScope', () => {
  it('release is idempotent and safe without an initialized sandbox manager', () => {
    // ASRT is never initialized in unit tests, so apply is a no-op — this
    // covers the bookkeeping contract: acquire/release/release never throws.
    const release = acquireSandboxNetworkScope({
      domains: ['example.com'],
      allowLocalBinding: false,
    })
    release()
    release()
  })
})
