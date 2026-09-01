import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureProviderHostApproved,
  getApprovedProviderHosts,
  rememberApprovedProviderHost,
  setApprovedProviderHosts,
} from './approved-provider-hosts.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
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

  it('preserves hosts remembered while an earlier write is still pending', async () => {
    let stored: readonly string[] = []
    let releaseFirstWrite: (() => void) | undefined
    let markFirstWriteStarted: (() => void) | undefined
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve
    })
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const store = {
      read: (): string[] => [...stored],
      write: async (hosts: readonly string[]): Promise<void> => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted?.()
          await firstWriteReleased
        }
        stored = hosts
      },
    }

    const rememberAcme = rememberApprovedProviderHost('api.acme.example', store)
    await firstWriteStarted
    const rememberBeta = rememberApprovedProviderHost('api.beta.example', store)
    releaseFirstWrite?.()
    await Promise.all([rememberAcme, rememberBeta])

    assert.deepEqual(stored, ['api.acme.example', 'api.beta.example'])
  })

  it('treats an unwritten setting as an empty allowlist, not the stored customs', async () => {
    // Until #438's grandfathering was dropped, an `approvedProviderHosts` that
    // had never been written synthesised an allowlist from the hosts of every
    // non-builtin `extraProviders` entry. It no longer does: an unset setting
    // approves nothing, and the host goes through the prompt once like any
    // other. `null` stands in for "never written" — `getSetting` falls back on
    // it exactly as it does on a missing key.
    await setSetting('extraProviders', [
      { slug: 'acme-custom', baseUrl: 'https://api.acme.example/v1' },
    ])
    await setSetting('approvedProviderHosts', null)

    assert.deepEqual(getApprovedProviderHosts(), [])

    let prompted = false
    setApprovalHandler(async () => {
      prompted = true
      return { approved: true, remember: true }
    })
    await ensureProviderHostApproved('https://api.acme.example/v1')
    assert.equal(prompted, true)
  })

  it('prompts above Settings and persists on ensureProviderHostApproved', async () => {
    let request: ApprovalRequest | undefined
    setApprovalHandler(async (next) => {
      request = next
      return { approved: true, remember: true }
    })
    await ensureProviderHostApproved('https://api.acme.example/v1')
    assert.equal(request?.showWhileSettingsOpen, true)
    assert.ok(getApprovedProviderHosts().includes('api.acme.example'))
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
