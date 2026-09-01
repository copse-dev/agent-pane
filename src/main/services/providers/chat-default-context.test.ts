import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateChatDefaultContext } from './chat-default-context.ts'
import { invalidateLmStudioModelsCache } from './lm-studio-models.ts'
import { setApiKey, deleteApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { jsonResponse } from './test-response.ts'

const AMBIENT_PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'OPENROUTER_API_KEY',
  'PARALLEL_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'MISTRAL_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'COPSE_PANEL_MOCK_LLM',
] as const

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
      return jsonResponse({
        models: Object.entries(contexts).map(([key, ctx]) => ({
          key,
          ...(ctx ? { max_context_length: ctx } : {}),
        })),
      })
    }
    return jsonResponse({ data: Object.keys(contexts).map((id) => ({ id })) })
  }
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

describe('evaluateChatDefaultContext', () => {
  let restoreFetch: (() => void) | undefined
  let originalEnvironment = new Map<string, string | undefined>()

  beforeEach(() => {
    originalEnvironment = new Map(
      AMBIENT_PROVIDER_ENV_VARS.map((name) => [name, process.env[name]]),
    )
    for (const name of AMBIENT_PROVIDER_ENV_VARS) Reflect.deleteProperty(process.env, name)
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
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
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

  it('treats mock-LLM mode as healthy without probing providers', async () => {
    const prev = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    // No fetch stub installed: a real probe would try the network. The guard must
    // short-circuit before that.
    try {
      const health = await evaluateChatDefaultContext()
      assert.equal(health.hasDecentChatDefault, true)
    } finally {
      if (prev === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = prev
    }
  })
})
