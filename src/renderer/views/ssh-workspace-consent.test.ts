import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  SSH_WORKSPACE_CONSENT_BODY,
  SSH_WORKSPACE_CONSENT_TITLE,
  createSshWorkspaceConsent,
} from './ssh-workspace-consent.ts'

const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

describe('createSshWorkspaceConsent', () => {
  it('says what turning SSH workspaces on means, including the missing sandbox', () => {
    const consent = createSshWorkspaceConsent(createFakeApi(), { onEnabled: () => {} })
    const text = consent.root.textContent
    assert.ok(text.includes(SSH_WORKSPACE_CONSENT_TITLE))
    assert.ok(text.includes(SSH_WORKSPACE_CONSENT_BODY))
    assert.match(SSH_WORKSPACE_CONSENT_BODY, /no sandbox/)
    assert.match(text, /turn it off again in Settings → Machines/)
  })

  it('turns the setting on only when asked, then hands back', async () => {
    const api = createFakeApi()
    await api.settings.set('sshWorkspaceEnabled', false)
    let enabled = 0
    const consent = createSshWorkspaceConsent(api, {
      onEnabled: () => {
        enabled += 1
      },
    })
    assert.equal(await api.settings.get('sshWorkspaceEnabled'), false, 'showing it changes nothing')

    consent.root.querySelector<HTMLButtonElement>('.ssh-consent-turn-on')?.click()
    await settle()
    assert.equal(await api.settings.get('sshWorkspaceEnabled'), true)
    assert.equal(enabled, 1)
  })

  it('leaves the setting alone when declined', async () => {
    const api = createFakeApi()
    await api.settings.set('sshWorkspaceEnabled', false)
    let cancelled = 0
    const consent = createSshWorkspaceConsent(api, {
      onEnabled: () => {
        assert.fail('declining must not turn it on')
      },
      onCancel: () => {
        cancelled += 1
      },
    })
    consent.root.querySelector<HTMLButtonElement>('.ssh-consent-cancel')?.click()
    await settle()
    assert.equal(cancelled, 1)
    assert.equal(await api.settings.get('sshWorkspaceEnabled'), false)
  })

  it('offers no Cancel when the caller has its own', () => {
    const consent = createSshWorkspaceConsent(createFakeApi(), { onEnabled: () => {} })
    assert.equal(consent.root.querySelector('.ssh-consent-cancel'), null)
  })

  it('reports a failed save and does not hand back', async () => {
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        set: async (): Promise<void> => Promise.reject(new Error('settings are read-only')),
      },
    }
    let enabled = 0
    const consent = createSshWorkspaceConsent(api, {
      onEnabled: () => {
        enabled += 1
      },
    })
    consent.root.querySelector<HTMLButtonElement>('.ssh-consent-turn-on')?.click()
    await settle()
    assert.equal(enabled, 0)
    assert.match(
      consent.root.querySelector('.ssh-consent-status')?.textContent ?? '',
      /settings are read-only/,
    )
  })
})
