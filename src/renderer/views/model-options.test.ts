import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, ExtraProvider } from '../../preload/api.d.ts'
import { resolveExtraProviders } from '@shared/llm/extra-providers.ts'
import { fetchModelOptions } from './model-options.ts'

interface MockOpts {
  available?: Record<string, boolean>
  extraProviders?: ExtraProvider[]
  openRouterModels?: Array<{ id: string; name: string }>
  lmStudioModels?: string[]
  openRouterModelSetting?: string
}

// availableProviders() returns explicit booleans for every provider; mirror that
// so the fail-open `?? true` default (used only on IPC failure) isn't triggered.
const ALL_UNCONFIGURED = {
  anthropic: false,
  openai: false,
  cursor: false,
  openrouter: false,
  mistral: false,
  gemini: false,
  deepseek: false,
}

// Minimal ApiClient stub exposing only what fetchModelOptions touches.
function mockApi(opts: MockOpts = {}): ApiClient {
  return {
    settings: {
      availableProviders: async () => ({ ...ALL_UNCONFIGURED, ...(opts.available ?? {}) }),
      extraProviders: async () => opts.extraProviders ?? resolveExtraProviders([]),
      get: async (key: string) =>
        key === 'openRouterModel' ? (opts.openRouterModelSetting ?? '') : null,
    },
    openRouter: { models: async () => opts.openRouterModels ?? [] },
    lmStudio: { models: async () => opts.lmStudioModels ?? [] },
  } as unknown as ApiClient
}

describe('fetchModelOptions visibility', () => {
  it('shows a single guiding message when nothing is configured', async () => {
    const options = await fetchModelOptions(mockApi(), '')
    assert.equal(options.length, 1)
    assert.match(options[0]!.label, /No models available/)
    assert.equal(options[0]!.disabled, true)
  })

  it('omits unconfigured providers entirely (no "add a key" rows)', async () => {
    const options = await fetchModelOptions(
      mockApi({ available: { mistral: true }, lmStudioModels: ['local-x'] }),
      '',
    )
    const labels = options.map((o) => o.label)
    assert.ok(!labels.some((l) => /Add a|Add an|API key in Settings/.test(l)))
    // Mistral (configured) + local model are present; no global empty message.
    assert.ok(options.some((o) => o.group === 'Mistral'))
    assert.ok(options.some((o) => o.value === 'lmstudio:local-x'))
    assert.ok(!labels.some((l) => /No models available/.test(l)))
  })

  it('hides the Cursor remote agent until its key is configured', async () => {
    const without = await fetchModelOptions(
      mockApi({ available: { anthropic: true } }),
      'claude-sonnet-4-6',
    )
    assert.ok(!without.some((o) => o.group === 'Remote agents'))

    const withKey = await fetchModelOptions(
      mockApi({ available: { anthropic: true, cursor: true } }),
      'claude-sonnet-4-6',
    )
    assert.ok(withKey.some((o) => o.group === 'Remote agents'))
  })

  it('keeps the current selection selectable even with no key', async () => {
    const options = await fetchModelOptions(mockApi(), 'gpt-5')
    const current = options.find((o) => o.value === 'gpt-5')
    assert.ok(current)
    assert.match(current.label, /no key/)
    // The current-selection fallback means we are not "empty", so no global message.
    assert.ok(!options.some((o) => /No models available/.test(o.label)))
  })
})
