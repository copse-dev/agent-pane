import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containedSandboxNetworkConfig } from './config.ts'
import {
  acquireSandboxNetworkScope,
  activeSandboxNetworkScopeLabels,
  isSandboxNetworkScopeActive,
  mergedScopeNetwork,
} from './network-scope.ts'

describe('mergedScopeNetwork', () => {
  it('is the contained deny-all base with no active scopes', () => {
    assert.deepEqual(mergedScopeNetwork([]), containedSandboxNetworkConfig())
  })

  it('unions domains and ORs local binding across scopes', () => {
    const merged = mergedScopeNetwork([
      { domains: ['anthropic.com', '*.anthropic.com'], allowLocalBinding: false, label: 'first' },
      { domains: ['*.googleapis.com', 'anthropic.com'], allowLocalBinding: true, label: 'second' },
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
      label: 'test scope',
    })
    release()
    release()
  })

  it('reports a widened scope until every concurrent holder releases', () => {
    const first = acquireSandboxNetworkScope({
      domains: ['first.example'],
      allowLocalBinding: false,
      label: 'first holder',
    })
    const second = acquireSandboxNetworkScope({
      domains: ['second.example'],
      allowLocalBinding: false,
      label: 'second holder',
    })
    try {
      assert.equal(isSandboxNetworkScopeActive(), true)
      first()
      assert.equal(isSandboxNetworkScopeActive(), true)
    } finally {
      second()
    }
    assert.equal(isSandboxNetworkScopeActive(), false)
  })

  it('names its holders so the shell prompt can attribute the widening', () => {
    assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
    const probe = acquireSandboxNetworkScope({
      domains: ['vendor.example'],
      allowLocalBinding: false,
      label: 'ACP agent: codex',
    })
    const server = acquireSandboxNetworkScope({
      domains: [],
      allowLocalBinding: true,
      label: 'background task: npm run dev',
    })
    try {
      assert.deepEqual(activeSandboxNetworkScopeLabels(), [
        'ACP agent: codex',
        'background task: npm run dev',
      ])
      probe()
      assert.deepEqual(activeSandboxNetworkScopeLabels(), ['background task: npm run dev'])
    } finally {
      server()
    }
    assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
  })

  it('deduplicates labels so two identical holders read as one', () => {
    const first = acquireSandboxNetworkScope({
      domains: ['vendor.example'],
      allowLocalBinding: false,
      label: 'ACP agent: codex',
    })
    const second = acquireSandboxNetworkScope({
      domains: ['vendor.example'],
      allowLocalBinding: false,
      label: 'ACP agent: codex',
    })
    try {
      assert.deepEqual(activeSandboxNetworkScopeLabels(), ['ACP agent: codex'])
    } finally {
      first()
      second()
    }
  })
})
