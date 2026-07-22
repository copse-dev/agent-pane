import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, ExtraProvider } from '../../preload/api.d.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { resolveExtraProviders } from '@copse/llm/extra-providers.ts'
import { fetchModelOptions } from './model-options.ts'

interface MockOpts {
  available?: Record<string, boolean>
  extraProviders?: ExtraProvider[]
  openRouterModels?: Array<{ id: string; name: string }>
  cursorCloudModels?: Array<{ id: string; label: string }>
  lmStudioModels?: string[]
  openRouterModelSetting?: string
  openRouterZdrOnlySetting?: boolean
  openRouterAllowTrainingSetting?: boolean
  acpAgents?: AcpAgentConfig[]
}

// availableProviders() returns explicit booleans for every provider; mirror that
// so the fail-open `?? true` default (used only on IPC failure) isn't triggered.
const ALL_UNCONFIGURED = {
  anthropic: false,
  openai: false,
  cursor: false,
  openrouter: false,
  perplexity: false,
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
        if (key === 'openRouterZdrOnly') return opts.openRouterZdrOnlySetting ?? null
        if (key === 'openRouterAllowTraining') return opts.openRouterAllowTrainingSetting ?? null
        if (key === 'registeredAcpAgents') return opts.acpAgents ?? null
        return null
      },
    },
    openRouter: { models: async () => opts.openRouterModels ?? [] },
    remoteAgent: { models: async () => opts.cursorCloudModels ?? [] },
    lmStudio: { models: async () => opts.lmStudioModels ?? [] },
  } as unknown as ApiClient
}

describe('fetchModelOptions visibility', () => {
  it('lists fetched Perplexity models only when its key is configured', async () => {
    const providers = resolveExtraProviders([
      { slug: 'perplexity', models: [{ id: 'openai/gpt-live' }] },
    ])
    const hidden = await fetchModelOptions(mockApi({ extraProviders: providers }), '')
    assert.ok(!hidden.some((option) => option.group?.startsWith('Perplexity')))

    const configured = await fetchModelOptions(
      mockApi({ available: { perplexity: true }, extraProviders: providers }),
      '',
    )
    assert.deepEqual(
      configured
        .filter((option) => option.group === 'Perplexity — retention varies by provider')
        .map((option) => option.value),
      ['perplexity:openai/gpt-live'],
    )
  })

  it('shows a guiding message when nothing is configured (footer / default)', async () => {
    const options = await fetchModelOptions(mockApi(), '')
    assert.equal(options.length, 1)
    const [option] = options
    assert.ok(option)
    assert.match(option.label, /No models available/)
    assert.equal(option.disabled, true)
  })

  it('offers best-value only when includeBestValue is set (Settings chat model)', async () => {
    const options = await fetchModelOptions(mockApi(), '', { includeBestValue: true })
    assert.equal(options.length, 2)
    const [bestValue, empty] = options
    assert.ok(bestValue)
    assert.equal(bestValue.value, 'auto:best-value')
    assert.match(bestValue.label, /Best value/)
    assert.ok(empty)
    assert.match(empty.label, /No models available/)
    assert.equal(empty.disabled, true)
    assert.ok(!(await fetchModelOptions(mockApi(), '')).some((o) => o.value === 'auto:best-value'))
  })

  it('omits unconfigured providers entirely (no "add a key" rows)', async () => {
    const options = await fetchModelOptions(
      mockApi({ available: { mistral: true }, lmStudioModels: ['local-x'] }),
      '',
    )
    const labels = options.map((o) => o.label)
    assert.ok(!labels.some((l) => /Add a|Add an|API key in Settings/.test(l)))
    // Mistral (configured) + local model are present; no global empty message.
    // Mistral's group heading carries the data-policy annotation (it trains on
    // free/Pro-plan inputs by default — see @copse/llm/data-policies.ts).
    assert.ok(options.some((o) => o.group === 'Mistral — may train on your data'))
    assert.ok(options.some((o) => o.value === 'lmstudio:local-x'))
    assert.ok(!labels.some((l) => /No models available/.test(l)))
  })

  it('annotates the OpenRouter group with the ZDR routing state', async () => {
    const openRouterModels = [{ id: 'openai/gpt-4o', name: 'GPT-4o' }]

    // Default (setting unset) → ZDR-only routing is on.
    const zdrOn = await fetchModelOptions(
      mockApi({ available: { openrouter: true }, openRouterModels }),
      '',
    )
    assert.ok(zdrOn.some((o) => o.group === 'OpenRouter (ZDR routing)'))

    // Explicitly off → upstream retention applies (training still denied), and
    // the heading says so.
    const zdrOff = await fetchModelOptions(
      mockApi({
        available: { openrouter: true },
        openRouterModels,
        openRouterZdrOnlySetting: false,
      }),
      '',
    )
    assert.ok(zdrOff.some((o) => o.group === 'OpenRouter — retention varies by provider'))

    // Both relaxed → the heading carries the may-train warning.
    const training = await fetchModelOptions(
      mockApi({
        available: { openrouter: true },
        openRouterModels,
        openRouterZdrOnlySetting: false,
        openRouterAllowTrainingSetting: true,
      }),
      '',
    )
    assert.ok(training.some((o) => o.group === 'OpenRouter — may train on your data'))
  })

  it('flags Hugging Face as partner-dependent in its group heading', async () => {
    const providers = resolveExtraProviders([
      { slug: 'huggingface', models: [{ id: 'org/model:together' }] },
    ])
    const options = await fetchModelOptions(
      mockApi({ available: { huggingface: true }, extraProviders: providers }),
      '',
    )
    assert.ok(options.some((o) => o.group === 'Hugging Face — retention varies by provider'))
  })

  it('hides each remote agent until its own provider key is configured', async () => {
    // No relevant keys → neither remote agent is offered.
    const none = await fetchModelOptions(mockApi(), 'claude-sonnet-4-6')
    assert.ok(!none.some((o) => o.value.startsWith('remote-agent:cursor')))
    assert.ok(!none.some((o) => o.value.startsWith('remote-agent:anthropic')))

    // An Anthropic key surfaces Claude Cloud Agent models (same ids as Cloud models).
    const anthropicOnly = await fetchModelOptions(
      mockApi({ available: { anthropic: true } }),
      'claude-sonnet-4-6',
    )
    const claudeRemote = anthropicOnly.filter((o) => o.group === 'Claude Cloud Agent')
    assert.ok(claudeRemote.some((o) => o.value === 'remote-agent:anthropic#claude-opus-4-8'))
    assert.ok(claudeRemote.some((o) => o.value === 'remote-agent:anthropic#claude-sonnet-4-6'))
    const sonnetRemote = claudeRemote.find(
      (o) => o.value === 'remote-agent:anthropic#claude-sonnet-4-6',
    )
    assert.ok(sonnetRemote)
    assert.match(sonnetRemote.label, /^Claude Sonnet 4\.6 — intellect /)
    assert.ok(!anthropicOnly.some((o) => o.value.startsWith('remote-agent:cursor')))

    // A Cursor key surfaces Default + live catalog under its own heading.
    const cursorKey = await fetchModelOptions(
      mockApi({
        available: { cursor: true },
        cursorCloudModels: [{ id: 'composer-2', label: 'Composer 2' }],
      }),
      'claude-sonnet-4-6',
    )
    const cursorRemote = cursorKey.filter((o) => o.group === 'Cursor Cloud Agent')
    assert.deepEqual(
      cursorRemote.map((o) => ({ value: o.value, label: o.label })),
      [
        { value: 'remote-agent:cursor', label: 'Default' },
        { value: 'remote-agent:cursor#composer-2', label: 'Composer 2' },
      ],
    )
  })

  it('lists an ACP agent without models as a single bare entry under its own heading', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          { id: 'gemini-cli', title: 'Gemini CLI', command: 'gemini', enabled: true },
          { id: 'off', title: 'Disabled Agent', command: 'x', enabled: false },
        ],
      }),
      '',
    )
    const acp = options.filter((o) => o.group === 'Gemini CLI Client (ACP)')
    assert.deepEqual(
      acp.map((o) => o.value),
      ['acp:gemini-cli'],
    )
    const [acpAgent] = acp
    assert.ok(acpAgent)
    assert.equal(acpAgent.label, 'Gemini CLI')
  })

  it('lists an ACP agent’s detected models under its heading, dropping the bare default', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          {
            id: 'cursor',
            title: 'Cursor',
            command: 'cursor-agent',
            args: ['acp'],
            enabled: true,
            availableModels: [
              { value: 'auto', label: 'Auto' },
              { value: 'opus[]', label: 'Opus 4.8' },
            ],
          },
        ],
      }),
      '',
    )
    const acp = options.filter((o) => o.group === 'Cursor Client (ACP)')
    assert.deepEqual(
      acp.map((o) => ({ value: o.value, label: o.label })),
      [
        { value: 'acp:cursor#auto', label: 'Auto' },
        // The agent's "Opus 4.8" label aliases to the sourced measurement, so
        // the row earns an intellect-only hint (ACP has no token pricing).
        { value: 'acp:cursor#opus[]', label: 'Opus 4.8 — intellect 55.7' },
      ],
    )
    // The bare "acp:cursor" (agent default) entry is intentionally omitted.
    assert.ok(!acp.some((o) => o.value === 'acp:cursor'))
  })

  it('keeps a selected-but-unconfigured ACP agent selectable', async () => {
    const options = await fetchModelOptions(mockApi(), 'acp:gemini-cli')
    const current = options.find((o) => o.value === 'acp:gemini-cli')
    assert.ok(current)
    assert.equal(current.group, 'ACP agents')
    assert.match(current.label, /not configured/)
  })

  it('omits ACP agents on SSH workspaces and marks a stale selection unavailable', async () => {
    const api = mockApi({
      available: { anthropic: true },
      acpAgents: [{ id: 'cursor', title: 'Cursor', command: 'cursor-agent', enabled: true }],
    })
    const options = await fetchModelOptions(api, 'acp:cursor', { sshWorkspace: true })
    assert.ok(!options.some((o) => o.group?.includes('(ACP)') && !o.disabled))
    assert.ok(!options.some((o) => o.value === 'acp:cursor' && !o.disabled))
    const stale = options.find((o) => o.value === 'acp:cursor')
    assert.ok(stale)
    assert.equal(stale.disabled, true)
    assert.match(stale.label, /unavailable on SSH/)
    assert.ok(options.some((o) => o.group === 'Cloud models'))
  })

  it('keeps a selected-but-unconfigured remote agent selectable with a clear label', async () => {
    const options = await fetchModelOptions(mockApi(), 'remote-agent:cursor#composer-2')
    const current = options.find((o) => o.value === 'remote-agent:cursor#composer-2')
    assert.ok(current)
    assert.equal(current.group, 'Cursor Cloud Agent')
    assert.match(current.label, /no valid key/)
  })

  it('adds an intellect hint to a remote-agent model that resolves to a measurement', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { cursor: true },
        // A Cursor Cloud model whose label aliases to a curated measurement.
        cursorCloudModels: [{ id: 'opus-4-8', label: 'Opus 4.8' }],
      }),
      '',
    )
    const row = options.find((o) => o.group === 'Cursor Cloud Agent' && /Opus 4\.8/.test(o.label))
    assert.ok(row)
    assert.match(row.label, /Opus 4\.8 — intellect 55\.7/)
  })

  it('omits whole-session agents from task-role model options', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { anthropic: true, cursor: true },
        cursorCloudModels: [{ id: 'opus-4-8', label: 'Opus 4.8' }],
        acpAgents: [
          {
            id: 'claude-code',
            title: 'Claude Code',
            command: 'claude',
            args: [],
            enabled: true,
          },
        ],
      }),
      '',
      { includeAgentModels: false },
    )

    assert.ok(options.some((option) => option.value === 'claude-haiku-4-5'))
    assert.ok(!options.some((option) => option.value.startsWith('remote-agent:')))
    assert.ok(!options.some((option) => option.value.startsWith('acp:')))
  })

  it('groups hosted cloud models under a heading', async () => {
    const options = await fetchModelOptions(mockApi({ available: { anthropic: true } }), '')
    const cloud = options.filter((o) => o.group === 'Cloud models')
    assert.ok(cloud.length > 0)
    assert.ok(cloud.some((o) => o.value.startsWith('claude')))
    // Every visible option now belongs to a heading (no headingless block).
    assert.ok(options.every((o) => o.group || !o.value))
  })

  it('classifies a catalog-known local model with a role hint, leaving unknowns bare', async () => {
    const options = await fetchModelOptions(
      mockApi({ lmStudioModels: ['qwen/qwen2.5-coder-32b', 'some-unknown-local'] }),
      '',
    )
    const known = options.find((o) => o.value === 'lmstudio:qwen/qwen2.5-coder-32b')
    assert.ok(known)
    assert.match(known.label, /qwen\/qwen2\.5-coder-32b — coder/)
    // It now carries a sourced AA measurement, shown quant-adjusted (~) for the
    // running quant rather than the composite fallback.
    assert.match(known.label, /intellect ~[\d.]+/)
    const unknown = options.find((o) => o.value === 'lmstudio:some-unknown-local')
    assert.ok(unknown)
    assert.equal(unknown.label, 'some-unknown-local')
  })

  it('annotates scored cloud models with intellect, blended price, and frontier', async () => {
    const options = await fetchModelOptions(
      mockApi({ available: { anthropic: true, openai: true } }),
      '',
    )
    const opus = options.find((o) => o.value === 'claude-opus-4-8')
    assert.ok(opus)
    assert.equal(opus.label, 'Claude Opus 4.8 — intellect 55.7 · $9/MTok · frontier')
    const haiku = options.find((o) => o.value === 'claude-haiku-4-5')
    assert.ok(haiku)
    // Haiku is dominated on the re-baselined frontier (a cheaper model reaches
    // its intellect), so it shows intellect and price without the frontier tag.
    assert.equal(haiku.label, 'Claude Haiku 4.5 — intellect 24 · $1.80/MTok')
    // gpt-4o is scored (11.2) but dominated, so it shows intellect and price
    // without the frontier tag.
    const gpt4o = options.find((o) => o.value === 'gpt-4o')
    assert.ok(gpt4o)
    assert.match(gpt4o.label, /^GPT-4o — intellect 11\.2 · \$[\d.]+\/MTok$/)
    assert.doesNotMatch(gpt4o.label, /frontier/)
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
