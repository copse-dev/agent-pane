import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateChatDefaultContext } from './chat-default-context.ts'
import { invalidateLmStudioModelsCache } from './lm-studio-models.ts'
import { setApiKey, deleteApiKey, setSetting } from './storage/settings.test-shim.ts'

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Stub the LM Studio model list with the given per-model context lengths. */
function stubLmStudio(contexts: Record<string, number | null>): () => void {
  const original = globalThis.fetch
  const impl: typeof fetch = async (input) => {
    const url = requestUrl(input)
    if (url.includes('/api/v1/models')) {
      return {
        ok: true,
        json: async () => ({
          models: Object.entries(contexts).map(([key, ctx]) => ({
            key,
            ...(ctx ? { max_context_length: ctx } : {}),
          })),
        }),
      } as Response
    }
    return {
      ok: true,
      json: async () => ({ data: Object.keys(contexts).map((id) => ({ id })) }),
    } as Response
  }
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

describe('evaluateChatDefaultContext', () => {
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    invalidateLmStudioModelsCache()
    // Start from a clean local-only slate: no cloud keys, no extra providers.
    for (const p of ['anthropic', 'openai', 'cursor', 'openrouter', 'mistral', 'gemini']) {
      deleteApiKey(p)
    }
    void setSetting('extraProviders', [])
  })

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  it('warns when only small-context local models are loaded', async () => {
    restoreFetch = stubLmStudio({ tiny: 4096, other: 8192 })
    const health = await evaluateChatDefaultContext()
    assert.equal(health.hasDecentChatDefault, false)
    assert.equal(health.bestAvailableContext, 8192)
  })

  it('is healthy when a loaded local model reaches the minimum', async () => {
    restoreFetch = stubLmStudio({ tiny: 4096, big: 32_768 })
    const health = await evaluateChatDefaultContext()
    assert.equal(health.hasDecentChatDefault, true)
    assert.equal(health.bestAvailableContext, 32_768)
  })

  it('is healthy when a cloud provider key is configured, even with tiny local models', async () => {
    setApiKey('anthropic', 'sk-ant-test')
    restoreFetch = stubLmStudio({ tiny: 4096 })
    const health = await evaluateChatDefaultContext()
    assert.equal(health.hasDecentChatDefault, true)
  })

  it('counts OpenRouter access as a decent default', async () => {
    setApiKey('openrouter', 'sk-or-test')
    restoreFetch = stubLmStudio({ tiny: 4096 })
    const health = await evaluateChatDefaultContext()
    assert.equal(health.hasDecentChatDefault, true)
  })

  it('does not count a local model whose context the server omits', async () => {
    restoreFetch = stubLmStudio({ unknown: null })
    const health = await evaluateChatDefaultContext()
    assert.equal(health.hasDecentChatDefault, false)
    assert.equal(health.bestAvailableContext, null)
  })
})
