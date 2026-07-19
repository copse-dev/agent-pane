import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureProviderHostApproved,
  getApprovedProviderHosts,
  setApprovedProviderHosts,
} from './approved-provider-hosts.ts'
import { setApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.ts'

describe('approved-provider-hosts', () => {
  beforeEach(async () => {
    await setSetting('extraProviders', [])
    await setSetting('approvedProviderHosts', [])
    await setSetting('providerAllowUserApproval', true)
    setApprovalHandler(null)
  })

  afterEach(() => {
    setApprovalHandler(null)
  })

  it('reads back hosts written via setApprovedProviderHosts', async () => {
    await setApprovedProviderHosts(['api.together.xyz', 'API.Together.XYZ'])
    assert.deepEqual(getApprovedProviderHosts(), ['api.together.xyz'])
  })

  it('prompts and persists on ensureProviderHostApproved', async () => {
    let prompted = false
    setApprovalHandler(async () => {
      prompted = true
      return { approved: true, remember: true }
    })
    await ensureProviderHostApproved('https://api.groq.com/openai/v1')
    assert.equal(prompted, true)
    assert.ok(getApprovedProviderHosts().includes('api.groq.com'))
  })

  it('hard-denies when user approval is disabled', async () => {
    await setSetting('providerAllowUserApproval', false)
    await assert.rejects(
      () => ensureProviderHostApproved('https://evil.example/v1'),
      /not approved/,
    )
  })

  it('skips the prompt for loopback and builtin hosts', async () => {
    let prompted = false
    setApprovalHandler(async () => {
      prompted = true
      return { approved: true, remember: true }
    })
    await ensureProviderHostApproved('http://127.0.0.1:1234/v1')
    await ensureProviderHostApproved('https://api.mistral.ai/v1')
    assert.equal(prompted, false)
  })
})
