import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createApiKeysSection } from './api-keys-section.ts'

interface StubState {
  savedKeys: Record<string, string>
}

function stubApi(state: StubState): ApiClient {
  return {
    settings: {
      getKey: async (provider: string): Promise<string | null> => state.savedKeys[provider] ?? null,
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
})
