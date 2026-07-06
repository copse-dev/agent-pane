import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createApiKeysSection } from './api-keys-section.ts'

interface StubState {
  savedKeys: Record<string, string>
  encrypted?: Record<string, boolean>
}

function stubApi(state: StubState): ApiClient {
  return {
    settings: {
      getKey: async (provider: string): Promise<string | null> => state.savedKeys[provider] ?? null,
      getKeyEncrypted: async (provider: string): Promise<boolean | null> => {
        if (!state.savedKeys[provider]) return null
        const enc = state.encrypted?.[provider]
        return enc === undefined ? true : enc
      },
      setKey: async (provider: string, value: string): Promise<void> => {
        state.savedKeys[provider] = value
      },
      validateKey: async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }),
    },
  } as unknown as ApiClient
}

describe('api-keys-section', () => {
  it('renders saved and unset key states with inline icons', async () => {
    const section = createApiKeysSection(stubApi({ savedKeys: { anthropic: 'sk-test' } }), {
      providers: ['anthropic', 'openai'],
      validateOnInput: false,
    })
    document.body.append(section.root)

    await section.refreshKeyStatus()

    const anthropicStatus = section.root.querySelector<HTMLElement>('[data-key="anthropic"]')
    const openaiStatus = section.root.querySelector<HTMLElement>('[data-key="openai"]')
    assert.ok(anthropicStatus)
    assert.ok(openaiStatus)
    assert.equal(anthropicStatus.textContent, 'saved')
    assert.equal(anthropicStatus.querySelector('.ui-icon')?.getAttribute('data-icon'), 'dot')
    assert.equal(openaiStatus.textContent, 'not set')
    assert.equal(openaiStatus.querySelector('.ui-icon')?.getAttribute('data-icon'), 'circle')
  })

  it('shows an encrypted at-rest badge for an OS-encrypted stored key', async () => {
    const section = createApiKeysSection(
      stubApi({ savedKeys: { anthropic: 'sk-test' }, encrypted: { anthropic: true } }),
      { providers: ['anthropic'], validateOnInput: false },
    )
    document.body.append(section.root)

    await section.refreshKeyStatus()

    const atRest = section.root.querySelector<HTMLElement>('[data-at-rest="anthropic"]')
    const note = section.root.querySelector<HTMLElement>('[data-at-rest-note]')
    assert.ok(atRest)
    assert.equal(atRest.textContent, 'Encrypted by OS keychain')
    assert.equal(atRest.querySelector('.ui-icon')?.getAttribute('data-icon'), 'check')
    assert.equal(note?.hidden, true)
  })

  it('warns with a plaintext badge and note when a key is stored unencrypted', async () => {
    const section = createApiKeysSection(
      stubApi({ savedKeys: { anthropic: 'sk-test' }, encrypted: { anthropic: false } }),
      { providers: ['anthropic'], validateOnInput: false },
    )
    document.body.append(section.root)

    await section.refreshKeyStatus()

    const atRest = section.root.querySelector<HTMLElement>('[data-at-rest="anthropic"]')
    const note = section.root.querySelector<HTMLElement>('[data-at-rest-note]')
    assert.ok(atRest)
    assert.equal(atRest.textContent, 'Stored unencrypted')
    assert.equal(atRest.querySelector('.ui-icon')?.getAttribute('data-icon'), 'triangle-alert')
    assert.ok(note)
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /keyring/i)
  })
})
