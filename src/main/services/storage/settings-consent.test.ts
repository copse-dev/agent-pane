import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { settingsConsentDetail } from './settings-consent.ts'

describe('settings consent boundary', () => {
  it('allows presentation-only updates without a native prompt', () => {
    assert.equal(settingsConsentDetail({ theme: 'dark', fontSize: 16 }), null)
  })

  it('includes every authority-changing value in the native prompt', () => {
    const detail = settingsConsentDetail({
      theme: 'dark',
      trustedShellCommands: ['git'],
      shellAutoApprovalLevel: 'remote-write',
      registeredAcpAgents: [{ id: 'agent', sandbox: false }],
    })
    assert.ok(detail)
    assert.ok(detail.includes('trustedShellCommands'))
    assert.ok(detail.includes('remote-write'))
    assert.ok(detail.includes('"sandbox": false'))
    assert.ok(!detail.includes('"theme"'))
  })

  it('requires consent for unknown future settings and refuses undisplayable changes', () => {
    assert.ok(settingsConsentDetail({ futurePermission: true }))
    assert.throws(() => settingsConsentDetail({ futurePermission: 'x'.repeat(12_001) }))
  })
})
