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
  acpAgents?: Array<{ id: string; title: string; command: string; enabled: boolean }>
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
  huggingface: false,
}

// Minimal ApiClient stub exposing only what fetchModelOptions touches.
function mockApi(opts: MockOpts = {}): ApiClient {
  return {
    settings: {
      availableProviders: async () => ({ ...ALL_UNCONFIGURED, ...(opts.available ?? {}) }),
      extraProviders: async () => opts.extraProviders ?? resolveExtraProviders([]),
      get: async (key: string) => {
        if (key === 'openRouterModel') return opts.openRouterModelSetting ?? ''
        if (key === 'registeredAcpAgents') return opts.acpAgents ?? null
        return null
      },
    },
    openRouter: { models: async () => opts.openRouterModels ?? [] },
    lmStudio: { models: async () => opts.lmStudioModels ?? [] },
  } as unknown as ApiClient
}

describe('fetchModelOptions visibility', () => {
  it('shows a single guiding message when nothing is configured', async () => {
    const options = await fetchModelOptions(mockApi(), '')
    assert.equal(options.length, 1)
    const [option] = options
    assert.ok(option)
    assert.match(option.label, /No models available/)
    assert.equal(option.disabled, true)
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

  it('hides each remote agent until its own provider key is configured', async () => {
    // No relevant keys → neither remote agent is offered.
    const none = await fetchModelOptions(mockApi(), 'claude-sonnet-4-6')
    assert.ok(!none.some((o) => o.value === 'remote-agent:cursor'))
    assert.ok(!none.some((o) => o.value === 'remote-agent:anthropic'))

    // An Anthropic key surfaces Claude Agent but not the Cursor agent.
    const anthropicOnly = await fetchModelOptions(
      mockApi({ available: { anthropic: true } }),
      'claude-sonnet-4-6',
    )
    assert.ok(anthropicOnly.some((o) => o.value === 'remote-agent:anthropic'))
    assert.ok(!anthropicOnly.some((o) => o.value === 'remote-agent:cursor'))

    // A Cursor key surfaces the Cursor agent.
    const cursorKey = await fetchModelOptions(
      mockApi({ available: { cursor: true } }),
      'claude-sonnet-4-6',
    )
    assert.ok(cursorKey.some((o) => o.value === 'remote-agent:cursor'))
    assert.ok(cursorKey.some((o) => o.group === 'Remote agents'))
  })

  it('lists enabled ACP agents under their own heading and hides disabled ones', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          { id: 'gemini-cli', title: 'Gemini CLI', command: 'gemini', enabled: true },
          { id: 'off', title: 'Disabled Agent', command: 'x', enabled: false },
        ],
      }),
      '',
    )
    const acp = options.filter((o) => o.group === 'ACP agents')
    assert.deepEqual(
      acp.map((o) => o.value),
      ['acp:gemini-cli'],
    )
    const [acpAgent] = acp
    assert.ok(acpAgent)
    assert.equal(acpAgent.label, 'Gemini CLI')
  })

  it('keeps a selected-but-unconfigured ACP agent selectable', async () => {
    const options = await fetchModelOptions(mockApi(), 'acp:gemini-cli')
    const current = options.find((o) => o.value === 'acp:gemini-cli')
    assert.ok(current)
    assert.equal(current.group, 'ACP agents')
    assert.match(current.label, /not configured/)
  })

  it('groups hosted cloud models under a heading', async () => {
    const options = await fetchModelOptions(mockApi({ available: { anthropic: true } }), '')
    const cloud = options.filter((o) => o.group === 'Cloud models')
    assert.ok(cloud.length > 0)
    assert.ok(cloud.some((o) => o.value.startsWith('claude')))
    // Every visible option now belongs to a heading (no headingless block).
    assert.ok(options.every((o) => o.group || !o.value))
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
