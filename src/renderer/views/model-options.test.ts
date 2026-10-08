import { ACP_RETENTION_NOTICE } from '@shared/acp-retention.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient, ExtraProvider } from '../../preload/api.d.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import { resolveExtraProviders } from '@copse/llm/extra-providers.ts'
import { cloudModelIntellectHint } from '@copse/llm/intellect-hints.ts'
import { getIntellectScore } from '@copse/llm/model-intellect.ts'
import {
  fetchModelOptions,
  fetchRoleModelOptions,
  localModelOptions,
  modelDisplayLabel,
} from './model-options.ts'
import { DEFAULT_SAFETY_MODEL } from '@shared/lm-studio-defaults.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { ModelCoverage } from './model-coverage.ts'

describe('native ChatGPT plan picker', () => {
  it('offers subscription models without an API key and preserves their registration', async () => {
    const base = mockApi()
    const api = {
      ...base,
      chatGptPlan: {
        ...base.chatGptPlan,
        models: async (): ReturnType<ApiClient['chatGptPlan']['models']> => ({
          clientId: 'oaiapp_account',
          models: [{ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }],
        }),
      },
    }
    const options = await fetchModelOptions(api, '')
    const plan = options.find((option) => option.group === 'ChatGPT plan')
    assert.ok(plan)
    assert.equal(plan.value, 'chatgpt-plan:oaiapp_account#gpt-6.1-sol')
    assert.equal(plan.label, 'GPT-6.1 Sol · ChatGPT plan')
    assert.equal(
      options.some((option) => option.value === 'gpt-6.1-sol'),
      false,
    )
  })
  it('retains a disconnected selection as disabled instead of substituting API billing', async () => {
    const current = 'chatgpt-plan:oaiapp_old#gpt-6.1-sol'
    const options = await fetchModelOptions(mockApi(), current)
    const plan = options.find((option) => option.value === current)
    assert.ok(plan)
    assert.equal(plan.disabled, true)
    assert.match(plan.label, /ChatGPT plan/)
  })
})

interface MockOpts {
  available?: Record<string, boolean>
  extraProviders?: ExtraProvider[]
  openRouterModels?: Array<{
    id: string
    name: string
    inputPricePerMTok?: number | null
    outputPricePerMTok?: number | null
  }>
  cursorCloudModels?: Array<{ id: string; label: string }>
  lmStudioModels?: string[]
  lmStudioModelInfo?: Array<{ id: string; supportsImages?: boolean; embedding?: boolean }>
  openRouterModelSetting?: string
  openRouterZdrOnlySetting?: boolean
  openRouterAllowTrainingSetting?: boolean
  blockedModelMakers?: string[]
  acpAgents?: AcpAgentConfig[]
  pluginModels?: Array<{ id: string; label: string; group?: string }>
  pluginEnabled?: boolean
  planUsage?: PlanUsageSnapshot
}

// availableProviders() returns explicit booleans for every provider; mirror that
// so the fail-open `?? true` default (used only on IPC failure) isn't triggered.
const ALL_UNCONFIGURED = {
  anthropic: false,
  openai: false,
  'openai:gpt-6-astra': false,
  cursor: false,
  openrouter: false,
  perplexity: false,
  mistral: false,
  gemini: false,
  deepseek: false,
  huggingface: false,
}

function intellectSuffix(modelId: string): string {
  const score = getIntellectScore(modelId)
  return score ? ` — intellect ${score.estimated ? '~' : ''}${String(score.value)}` : ''
}

function currentCloudIntellectHint(modelId: string): string {
  const hint = cloudModelIntellectHint(modelId)
  assert.ok(hint, `expected an intellect hint for ${modelId}`)
  return hint
}

// Minimal ApiClient stub exposing only what fetchModelOptions touches.
function mockApi(opts: MockOpts = {}): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      usage: {
        ...base.usage,
        getPlanUsage: async () => opts.planUsage ?? { checkedAt: '', providers: [] },
      },
      settings: {
        ...base['settings'],
        availableProviders: async () => ({ ...ALL_UNCONFIGURED, ...(opts.available ?? {}) }),
        extraProviders: async () => opts.extraProviders ?? resolveExtraProviders([]),
        get: async (key: string): Promise<unknown> => {
          if (key === 'openRouterModel') return opts.openRouterModelSetting ?? ''
          if (key === 'openRouterZdrOnly') return opts.openRouterZdrOnlySetting ?? null
          if (key === 'openRouterAllowTraining') return opts.openRouterAllowTrainingSetting ?? null
          if (key === 'blockedModelMakers') return opts.blockedModelMakers ?? []
          if (key === 'registeredAcpAgents') return opts.acpAgents ?? null
          return null
        },
      },
      openRouter: {
        ...base['openRouter'],
        models: async () =>
          (opts.openRouterModels ?? []).map((model) => ({
            ...model,
            inputPricePerMTok: model.inputPricePerMTok ?? null,
            outputPricePerMTok: model.outputPricePerMTok ?? null,
          })),
      },
      remoteAgent: {
        ...base['remoteAgent'],
        models: async () => opts.cursorCloudModels ?? [],
      },
      lmStudio: {
        ...base['lmStudio'],
        models: async () => opts.lmStudioModels ?? [],
        ...(opts.lmStudioModelInfo === undefined
          ? {}
          : { modelInfo: async () => opts.lmStudioModelInfo ?? [] }),
      },
      plugins: {
        ...base['plugins'],
        list: async () => ({
          plugins:
            opts.pluginModels === undefined
              ? []
              : [
                  {
                    id: 'personal.reference-model',
                    trust: 'user',
                    stability: 'experimental',
                    name: 'personal.reference-model',
                    enabled: opts.pluginEnabled ?? true,
                    contributions: {
                      toolNames: [],
                      modelRoutes: opts.pluginModels,
                      browserOrigins: [],
                      blockingHooks: [],
                      asyncHooks: [],
                      commandHooks: [],
                      promptBlocks: [],
                      ui: [],
                      followUps: [],
                      capabilities: [],
                      instructionSources: [],
                      permissions: [],
                    },
                    settings: [],
                  },
                ],
        }),
      },
    } satisfies ApiClient
  })()
}

describe('fetchModelOptions visibility', () => {
  it('offers prompt matching for primary agents only', async () => {
    const primary = await fetchModelOptions(mockApi(), '')
    const auxiliary = await fetchModelOptions(mockApi(), '', { includeAgentModels: false })
    assert.equal(primary.filter((option) => option.value === 'auto:match-prompt').length, 1)
    assert.equal(
      auxiliary.some((option) => option.value === 'auto:match-prompt'),
      false,
    )
  })
  it('marks only catalog routes with both known zero token prices as free', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { openrouter: true },
        openRouterModels: [
          { id: 'vendor/zero', name: 'Zero', inputPricePerMTok: 0, outputPricePerMTok: 0 },
          {
            id: 'vendor/input-paid',
            name: 'Input paid',
            inputPricePerMTok: 1,
            outputPricePerMTok: 0,
          },
          {
            id: 'vendor/output-paid',
            name: 'Output paid',
            inputPricePerMTok: 0,
            outputPricePerMTok: 1,
          },
          { id: 'vendor/unknown:free', name: 'Free in name', inputPricePerMTok: 0 },
          {
            id: 'vendor/router:free',
            name: 'Free router',
            inputPricePerMTok: 1,
            outputPricePerMTok: 1,
          },
        ],
        openRouterModelSetting: 'vendor/custom:free',
      }),
      '',
    )
    const coverage = (id: string): ModelCoverage | undefined =>
      options.find((option) => option.value === `openrouter:${id}`)?.coverage
    assert.equal(coverage('vendor/zero'), 'free')
    for (const id of [
      'vendor/input-paid',
      'vendor/output-paid',
      'vendor/unknown:free',
      'vendor/router:free',
      'vendor/custom:free',
    ]) {
      assert.equal(coverage(id), 'paid', id)
    }
  })

  it('attaches plan coverage to the agent route without covering the same API model', async () => {
    const api = mockApi({
      available: { anthropic: true },
      lmStudioModels: ['qwen-local'],
      acpAgents: [
        {
          id: 'claude-acp',
          title: 'Claude Code',
          command: 'claude-agent-acp',
          enabled: true,
          availableModels: [{ value: 'sonnet', label: 'Claude Sonnet 4.6' }],
        },
      ],
      planUsage: {
        checkedAt: '2026-10-01T00:00:00Z',
        providers: [
          {
            provider: 'claude',
            status: 'ok',
            usage: {
              provider: 'claude',
              plan: 'Max',
              checkedAt: '2026-10-01T00:00:00Z',
              windows: [{ id: 'seven_day', label: 'Weekly', usedPercent: 20, resetsAt: null }],
            },
          },
        ],
      },
    })
    const options = await fetchModelOptions(api, '')
    assert.equal(
      options.find((option) => option.value === 'acp:claude-acp#sonnet')?.coverage,
      'plan',
    )
    assert.equal(options.find((option) => option.value === 'claude-sonnet-4-6')?.coverage, 'paid')
    assert.equal(
      options.find((option) => option.value === 'lmstudio:qwen-local')?.coverage,
      'local',
    )
    api.usage.getPlanUsage = (): Promise<PlanUsageSnapshot> =>
      Promise.reject(new Error('Usage unavailable'))
    const fallback = await fetchModelOptions(api, '')
    assert.equal(
      fallback.find((option) => option.value === 'acp:claude-acp#sonnet')?.coverage,
      'paid',
    )
    assert.equal(
      fallback.find((option) => option.value === 'lmstudio:qwen-local')?.coverage,
      'local',
    )
  })

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
    const concrete = options.filter((option) => option.value !== 'auto:match-prompt')
    assert.equal(concrete.length, 1)
    const [option] = concrete
    assert.ok(option)
    assert.match(option.label, /No models available/)
    assert.equal(option.disabled, true)
  })

  it('offers best-value plus the other automatic selectors when includeBestValue is set (Settings chat model)', async () => {
    const options = await fetchModelOptions(mockApi(), '', { includeBestValue: true })
    // Automatic choices plus the empty placeholder.
    const values = options.map((o) => o.value)
    assert.ok(values.includes('auto:best-value'))
    assert.ok(values.includes('auto:balanced'), 'balanced should be selectable in Settings')
    assert.ok(values.includes('auto:balanced-included'), 'no-charge balanced should be selectable')
    const bestValue = options.find((o) => o.value === 'auto:best-value')
    assert.ok(bestValue, 'missing best-value row')
    assert.match(bestValue.label, /Best value/)
    assert.ok(options.some((o) => o.disabled && /No models available/.test(o.label)))
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

  it('prefers a Claude ACP agent over the API-billed Claude Cloud Agent', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { anthropic: true },
        acpAgents: [
          {
            id: 'claude-acp',
            title: 'Claude',
            command: 'claude-agent-acp',
            enabled: true,
          },
        ],
      }),
      '',
    )
    // The Claude Cloud Agent heading is flagged as API-billed so ACP reads as
    // the preferred (own-login) alternative.
    const claudeCloud = options.filter(
      (o) => o.group === 'Claude Cloud Agent (billed to your API key)',
    )
    assert.ok(claudeCloud.some((o) => o.value === 'remote-agent:anthropic#claude-opus-4-8'))
    // No un-annotated Claude Cloud Agent heading remains.
    assert.ok(!options.some((o) => o.group === 'Claude Cloud Agent'))

    // The ACP agent's rows come before the Claude Cloud Agent's rows.
    const firstAcpIdx = options.findIndex((o) => o.value.startsWith('acp:'))
    const firstRemoteIdx = options.findIndex((o) => o.value.startsWith('remote-agent:anthropic'))
    assert.ok(firstAcpIdx >= 0 && firstRemoteIdx >= 0)
    assert.ok(firstAcpIdx < firstRemoteIdx)
  })

  it('keeps the Claude Cloud Agent first (unflagged) with no enabled Claude ACP agent', async () => {
    // A non-Claude ACP agent (Gemini) does not trigger the preference.
    const options = await fetchModelOptions(
      mockApi({
        available: { anthropic: true },
        acpAgents: [{ id: 'gemini', title: 'Gemini CLI', command: 'gemini', enabled: true }],
      }),
      '',
    )
    assert.ok(options.some((o) => o.group === 'Claude Cloud Agent'))
    assert.ok(!options.some((o) => o.group?.includes('billed to your API key')))
    const firstRemoteIdx = options.findIndex((o) => o.value.startsWith('remote-agent:anthropic'))
    const firstAcpIdx = options.findIndex((o) => o.value.startsWith('acp:'))
    assert.ok(firstRemoteIdx >= 0 && firstAcpIdx >= 0)
    assert.ok(firstRemoteIdx < firstAcpIdx)
  })

  it('lists an ACP agent without models as a single bare entry under its own heading', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          { id: 'gemini', title: 'Gemini CLI', command: 'gemini', enabled: true },
          { id: 'off', title: 'Disabled Agent', command: 'x', enabled: false },
        ],
      }),
      '',
    )
    const acp = options.filter((o) => o.group === 'Gemini CLI on this device')
    assert.deepEqual(
      acp.map((o) => o.value),
      ['acp:gemini'],
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
    const acp = options.filter((o) => o.group === 'Cursor on this device')
    assert.deepEqual(
      acp.map((o) => ({ value: o.value, label: o.label })),
      [
        { value: 'acp:cursor#auto', label: 'Auto' },
        // The agent's "Opus 4.8" label aliases to the sourced measurement, so
        // the row earns an intellect-only hint (ACP has no token pricing), and
        // is spelled the way every other group spells the same model.
        {
          value: 'acp:cursor#opus[]',
          label: `Claude Opus 4.8${intellectSuffix('claude-opus-4-8')}`,
        },
      ],
    )
    // The bare "acp:cursor" (agent default) entry is intentionally omitted.
    assert.ok(!acp.some((o) => o.value === 'acp:cursor'))
  })

  it('gives the same Grok model one label and measured score across providers', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { openrouter: true, cursor: true },
        openRouterModels: [
          { id: 'x-ai/grok-build-0.1', name: 'xAI: Grok Build 0.1' },
          { id: 'x-ai/grok-4.3', name: 'SpaceXAI: Grok 4.3' },
        ],
        cursorCloudModels: [
          { id: 'grok-build-0.1', label: 'grok-build-0.1' },
          { id: 'grok-4.3', label: 'grok-4.3' },
        ],
        acpAgents: [
          {
            id: 'cursor',
            title: 'Cursor',
            command: 'cursor-agent',
            enabled: true,
            availableModels: [
              { value: 'grok-build-0.1', label: 'grok-build-0.1' },
              { value: 'grok-4.3', label: 'grok-4.3' },
            ],
          },
        ],
      }),
      '',
    )
    const buildRoutes = options.filter((option) => option.value.endsWith('grok-build-0.1'))
    assert.equal(buildRoutes.length, 3)
    for (const route of buildRoutes) {
      assert.equal(route.label, `Grok Build 0.1${intellectSuffix('grok-build-0-1-06-16')}`)
    }
    const grok43Routes = options.filter((option) => option.value.endsWith('grok-4.3'))
    assert.equal(grok43Routes.length, 3)
    assert.ok(grok43Routes.every((route) => route.label === 'Grok 4.3'))
  })

  it('blocks xAI across OpenRouter and named agent models while preserving z-ai', async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { openrouter: true, cursor: true },
        blockedModelMakers: ['xai'],
        openRouterModels: [
          { id: 'x-ai/grok-4.5', name: 'Grok 4.5' },
          { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
        ],
        cursorCloudModels: [
          { id: 'grok-4.5', label: 'Grok 4.5' },
          { id: 'composer-2', label: 'Composer 2' },
        ],
        acpAgents: [
          {
            id: 'cursor',
            title: 'Cursor',
            command: 'cursor-agent',
            enabled: true,
            availableModels: [
              { value: 'grok-4.5', label: 'Grok 4.5' },
              { value: 'composer-2', label: 'Composer 2' },
            ],
          },
        ],
      }),
      '',
    )
    assert.ok(!options.some((option) => option.value.includes('grok')))
    assert.ok(options.some((option) => option.value === 'openrouter:z-ai/glm-5.3'))
    assert.ok(options.some((option) => option.value === 'remote-agent:cursor#composer-2'))
    assert.ok(options.some((option) => option.value === 'acp:cursor#composer-2'))
  })

  it('keeps a selected blocked model visible only as a disabled explanation', async () => {
    const selected = 'openrouter:x-ai/grok-4.5'
    const options = await fetchModelOptions(
      mockApi({
        available: { openrouter: true },
        blockedModelMakers: ['xai'],
        openRouterModels: [{ id: 'x-ai/grok-4.5', name: 'Grok 4.5' }],
      }),
      selected,
    )
    assert.equal(options.filter((option) => option.value === selected).length, 1)
    assert.equal(options.find((option) => option.value === selected)?.disabled, true)
    assert.match(
      options.find((option) => option.value === selected)?.label ?? '',
      /blocked in Settings/,
    )
  })

  it('normalises raw GPT model ids advertised by an ACP agent', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          {
            id: 'codex-acp',
            title: 'Codex',
            command: 'codex-acp',
            enabled: true,
            availableModels: [
              { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano' },
              { value: 'gpt-5.1', label: 'gpt-5.1' },
              { value: 'gpt-5-mini', label: 'gpt-5-mini' },
              { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
            ],
          },
        ],
      }),
      '',
    )

    assert.deepEqual(
      options.filter((option) => option.group === 'Codex on this device').map((o) => o.label),
      [
        'GPT-5.4 nano',
        'GPT-5.1',
        `GPT-5 mini${intellectSuffix('gpt-5-mini')}`,
        `GPT-5.6 Sol${intellectSuffix('gpt-5.6-sol')}`,
      ],
    )
  })

  it('shows the version an agent keeps in the model description, and scores it', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          {
            id: 'claude-acp',
            title: 'Claude',
            command: 'claude-agent-acp',
            enabled: true,
            availableModels: [
              {
                value: 'default',
                label: 'Default (recommended)',
                description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
              },
              {
                value: 'opus[1m]',
                label: 'Opus (1M context)',
                description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
              },
              {
                value: 'sonnet',
                label: 'Sonnet',
                description: 'Sonnet 5 · Efficient for routine tasks',
              },
            ],
          },
        ],
      }),
      '',
    )
    assert.deepEqual(
      options.filter((o) => o.group === 'Claude on this device').map((o) => o.label),
      [
        // Claude Code labels its models bare, so the picker folds the version
        // from the description back in — and resolves the hint through it (the
        // agent's own `sonnet` value aliases to nothing).
        `Default (recommended) — Claude Opus 5${intellectSuffix('claude-opus-5')}`,
        `Claude Opus 5 (1M context)${intellectSuffix('claude-opus-5')}`,
        `Claude Sonnet 5${intellectSuffix('claude-sonnet-5')}`,
      ],
    )
  })

  it('lists Sonnet 5.5 before the retained Sonnet 5 and 4.6 cloud options', async () => {
    const options = await fetchModelOptions(mockApi({ available: { anthropic: true } }), '')
    const cloud = options.filter((o) => o.group === 'Cloud models')
    const values = cloud.map((o) => o.value)
    assert.ok(values.includes('claude-sonnet-5-5'))
    assert.ok(values.indexOf('claude-sonnet-5-5') < values.indexOf('claude-sonnet-5'))
    assert.ok(values.indexOf('claude-sonnet-5') < values.indexOf('claude-sonnet-4-6'))
    assert.match(
      cloud.find((o) => o.value === 'claude-sonnet-5-5')?.label ?? '',
      /^Claude Sonnet 5\.5\b/,
    )
  })

  it('keeps a selected-but-unconfigured ACP agent selectable', async () => {
    const options = await fetchModelOptions(mockApi(), 'acp:gemini-cli')
    const current = options.find((o) => o.value === 'acp:gemini-cli')
    assert.ok(current)
    assert.equal(current.group, 'Agents on this device')
    assert.match(current.label, /not configured/)
  })

  it('keeps a legacy ACP id attached to its renamed configured agent', async () => {
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [{ id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true }],
      }),
      'acp:codex',
    )
    const current = options.find((option) => option.value === 'acp:codex')
    assert.deepEqual(current, {
      value: 'acp:codex',
      label: 'Codex',
      retention: ACP_RETENTION_NOTICE,
      group: 'Codex on this device',
      coverage: 'paid',
    })
  })

  it('distinguishes an unadvertised model from an unconfigured ACP agent', async () => {
    const staleValue = 'acp:cursor#composer-2.5[fast=true]'
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          {
            id: 'cursor',
            title: 'Cursor',
            command: 'cursor-agent',
            enabled: true,
            availableModels: [{ value: 'composer-2.5[fast=false]', label: 'Composer 2.5' }],
          },
        ],
      }),
      staleValue,
    )
    const current = options.find((option) => option.value === staleValue)
    assert.deepEqual(current, {
      value: staleValue,
      label: 'Cursor — composer-2.5[fast=true] (not currently advertised)',
      retention: ACP_RETENTION_NOTICE,
      group: 'Cursor on this device',
      coverage: 'paid',
    })
  })

  it('names the agent default when an unadvertised ACP selection has no model', async () => {
    // `acp:cursor` carries no `#<model>`, so there is no model name to show —
    // the agent picks. Deriving one by slicing at `#` echoes the whole raw
    // selection back when there is no `#` at all.
    const staleValue = 'acp:cursor'
    const options = await fetchModelOptions(
      mockApi({
        acpAgents: [
          {
            id: 'cursor',
            title: 'Cursor',
            command: 'cursor-agent',
            enabled: true,
            availableModels: [{ value: 'composer-2.5[fast=false]', label: 'Composer 2.5' }],
          },
        ],
      }),
      staleValue,
    )
    const current = options.find((option) => option.value === staleValue)
    assert.deepEqual(current, {
      value: staleValue,
      label: 'Cursor — agent default (not currently advertised)',
      retention: ACP_RETENTION_NOTICE,
      group: 'Cursor on this device',
      coverage: 'paid',
    })
  })

  it('omits ACP agents on SSH workspaces and marks a stale selection unavailable', async () => {
    const api = mockApi({
      available: { anthropic: true },
      acpAgents: [{ id: 'cursor', title: 'Cursor', command: 'cursor-agent', enabled: true }],
    })
    const options = await fetchModelOptions(api, 'acp:cursor', { sshWorkspace: true })
    assert.ok(!options.some((o) => o.group?.includes('on this device') && !o.disabled))
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

  it('labels a selected dynamic rule by its purpose, not as a missing key', async () => {
    const options = await fetchModelOptions(mockApi(), 'auto:balanced')
    const current = options.find((o) => o.value === 'auto:balanced')
    assert.ok(current)
    assert.equal(current.label, 'Balanced')
    assert.doesNotMatch(current.label, /no key/)
  })

  it('names a selected cloud model whose provider has no key, not its raw id', async () => {
    const id = 'claude-opus-4-8'
    const options = await fetchModelOptions(mockApi(), id)
    const current = options.find((o) => o.value === id)
    assert.ok(current)
    assert.notEqual(
      modelDisplayLabel(id),
      id,
      'fixture must have a display name distinct from its id',
    )
    assert.equal(current.label, `${modelDisplayLabel(id)} (no key)`)
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
    assert.equal(row.label, `Claude Opus 4.8${intellectSuffix('claude-opus-4-8')}`)
  })

  it("spells Cursor's Claude models the way every other group spells them", async () => {
    const options = await fetchModelOptions(
      mockApi({
        available: { cursor: true },
        cursorCloudModels: [
          // Cursor names Claude models its own way: no vendor on one, the
          // version ahead of the family on the next. Its own models keep the
          // name Cursor gave them.
          { id: 'claude-opus-5', label: 'Opus 5' },
          { id: 'claude-4.6-sonnet-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
          { id: 'composer-2', label: 'Composer 2' },
        ],
      }),
      '',
    )
    assert.deepEqual(
      options.filter((o) => o.group === 'Cursor Cloud Agent').map((o) => o.label),
      [
        'Default',
        `Claude Opus 5${intellectSuffix('claude-opus-5')}`,
        'Claude Sonnet 4.6 (Thinking)',
        'Composer 2',
      ],
    )
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

  it('shows enabled selected-plugin models only in whole-thread pickers', async () => {
    const api = mockApi({
      pluginModels: [{ id: 'judge:default', label: 'Reference judge', group: 'Personal models' }],
    })
    const options = await fetchModelOptions(api, '')
    assert.deepEqual(
      options.find((option) => option.group === 'Personal models'),
      {
        value: 'plugin-model:personal.reference-model:judge%3Adefault',
        label: 'Reference judge',
        group: 'Personal models',
        coverage: 'paid',
      },
    )
    assert.equal(
      modelDisplayLabel('plugin-model:personal.reference-model:judge%3Adefault'),
      'judge:default',
    )
    const roles = await fetchModelOptions(api, '', { includeAgentModels: false })
    assert.ok(!roles.some((option) => option.value.startsWith('plugin-model:')))
  })

  it('keeps a disabled plugin model visible but unavailable', async () => {
    const options = await fetchModelOptions(
      mockApi({
        pluginEnabled: false,
        pluginModels: [{ id: 'judge:default', label: 'Reference judge', group: 'Personal models' }],
      }),
      'plugin-model:personal.reference-model:judge%3Adefault',
    )
    const selected = options.find((option) => option.value.startsWith('plugin-model:'))
    assert.ok(selected)
    assert.equal(selected.disabled, true)
    assert.equal(selected.label, 'Reference judge (plugin disabled)')
    assert.equal(selected.group, 'Personal models')
  })

  it('groups hosted cloud models under a heading', async () => {
    const options = await fetchModelOptions(mockApi({ available: { anthropic: true } }), '')
    const cloud = options.filter((o) => o.group === 'Cloud models')
    assert.ok(cloud.length > 0)
    assert.ok(cloud.some((o) => o.value.startsWith('claude')))
    // Every visible option now belongs to a heading (no headingless block).
    assert.ok(options.every((o) => Boolean(o.group) || !o.value))
  })

  it('classifies a catalog-known local model with a role hint, leaving unknowns bare', async () => {
    const options = await fetchModelOptions(
      mockApi({ lmStudioModels: ['qwen/qwen2.5-coder-32b', 'some-unknown-local'] }),
      '',
    )
    const known = options.find((o) => o.value === 'lmstudio:qwen/qwen2.5-coder-32b')
    assert.ok(known)
    // A catalog-known weight shows its curated name, so the only dash in the
    // row is the one introducing the app's own hints.
    assert.match(known.label, /^Qwen2\.5-Coder 32B — coder/)
    // It now carries a sourced AA measurement, shown quant-adjusted (~) for the
    // running quant rather than the composite fallback.
    assert.match(known.label, /intellect ~[\d.]+/)
    // An unknown weight has no curated name and no hints, but is still spelled
    // as a name rather than left as an id.
    const unknown = options.find((o) => o.value === 'lmstudio:some-unknown-local')
    assert.ok(unknown)
    assert.equal(unknown.label, 'Some Unknown Local')
  })

  it('annotates scored cloud models with intellect, blended price, and frontier', async () => {
    const options = await fetchModelOptions(
      mockApi({ available: { anthropic: true, openai: true, 'openai:gpt-6-astra': true } }),
      '',
    )
    // Opus 5 joins the frontier at the same $9/MTok as Opus 4.8 but higher
    // intellect, so the frontier flag rides on 5 and 4.8 becomes dominated.
    const opus5 = options.find((o) => o.value === 'claude-opus-5')
    assert.ok(opus5)
    assert.equal(opus5.label, `Claude Opus 5 — ${currentCloudIntellectHint('claude-opus-5')}`)
    const opus = options.find((o) => o.value === 'claude-opus-4-8')
    assert.ok(opus)
    assert.equal(opus.label, `Claude Opus 4.8 — ${currentCloudIntellectHint('claude-opus-4-8')}`)
    assert.doesNotMatch(opus.label, /frontier/)
    const haiku = options.find((o) => o.value === 'claude-haiku-4-5')
    assert.ok(haiku)
    assert.equal(haiku.label, `Claude Haiku 4.5 — ${currentCloudIntellectHint('claude-haiku-4-5')}`)
    const gpt4o = options.find((o) => o.value === 'gpt-4o')
    assert.ok(gpt4o)
    assert.equal(gpt4o.label, `GPT-4o — ${currentCloudIntellectHint('gpt-4o')}`)
  })

  it('only shows GPT-6 Astra when the OpenAI account advertises it', async () => {
    const unavailable = await fetchModelOptions(mockApi({ available: { openai: true } }), '')
    assert.equal(
      unavailable.some((option) => option.value === 'gpt-6-astra'),
      false,
    )

    const available = await fetchModelOptions(
      mockApi({ available: { openai: true, 'openai:gpt-6-astra': true } }),
      '',
    )
    assert.equal(
      available.some((option) => option.value === 'gpt-6-astra'),
      true,
    )
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

/**
 * A role can be pinned to a local model that was never downloaded — the safety
 * role ships pre-pinned to one, so a fresh install whose download never
 * finished is exactly this case. The picker must say so: a `<select>` whose
 * value matches no option renders the *first* option instead, which here reads
 * as "auto" — the one thing the setting is not.
 */
describe('a local model that is configured but not available', () => {
  it('keeps the pinned id as its own row, flagged as not available', () => {
    const options = localModelOptions(['google/gemma-4-e4b'], '(auto)', 'qwen/qwen3-4b-2507')
    const pinned = options.find((o) => o.value === 'qwen/qwen3-4b-2507')
    assert.ok(pinned)
    assert.match(pinned.label, /not available/)
  })

  it('adds no extra row when the pinned id is installed', () => {
    const options = localModelOptions(['google/gemma-4-e4b'], '(auto)', 'google/gemma-4-e4b')
    assert.equal(options.length, 2)
    assert.ok(!options.some((o) => /not available/.test(o.label)))
  })

  it('adds no extra row when nothing is pinned', () => {
    assert.deepEqual(localModelOptions(['a'], '(auto)'), [
      { value: '', label: '(auto)' },
      { value: 'a', label: 'a' },
    ])
  })

  it('says "not available" when the server answered, "offline" when it did not', async () => {
    const listed = await fetchModelOptions(
      mockApi({ lmStudioModels: ['google/gemma-4-e4b'] }),
      'lmstudio:qwen/qwen3-4b-2507',
    )
    const absent = listed.find((o) => o.value === 'lmstudio:qwen/qwen3-4b-2507')
    assert.ok(absent)
    assert.match(absent.label, /not available/)

    const unreachable = await fetchModelOptions(
      mockApi({ lmStudioModels: [] }),
      'lmstudio:qwen/qwen3-4b-2507',
    )
    const offline = unreachable.find((o) => o.value === 'lmstudio:qwen/qwen3-4b-2507')
    assert.ok(offline)
    assert.match(offline.label, /offline/)
  })
})

describe('role pickers and the safety default', () => {
  it('offers the exact rule the safety role defaults to', async () => {
    // A `<select>` whose value matches no option renders its *first* option
    // instead, and the pinned-id fallback would label the rule
    // "auto:min-intellect:20 (no key)". The default must be a real row.
    const options = await fetchRoleModelOptions(mockApi(), DEFAULT_SAFETY_MODEL)
    const row = options.find((o) => o.value === DEFAULT_SAFETY_MODEL)
    assert.ok(row, `no option for ${DEFAULT_SAFETY_MODEL}`)
    assert.doesNotMatch(row.label, /no key/)
  })

  it('offers the automatic rules but never a role rule', async () => {
    const options = await fetchRoleModelOptions(mockApi(), '')
    assert.ok(options.some((o) => o.value === 'auto:best-local'))
    // Pointing a role at a role is circular.
    assert.ok(!options.some((o) => o.value.startsWith('auto:role:')))
  })
})

// #2487. `text-embedding-nomic-embed-text-v1.5` was listed alongside the chat
// models. It has no chat completion, so picking it — as the chat model or as a
// comparison reviewer — produces a run that cannot start, and nothing on the row
// said so.
describe('embedding models are not offered', () => {
  it('drops a model the server flagged as an embedding model', async () => {
    const options = await fetchModelOptions(
      mockApi({
        lmStudioModelInfo: [
          { id: 'text-embedding-nomic-embed-text-v1.5', embedding: true },
          { id: 'qwen3-coder-30b' },
        ],
      }),
      '',
    )
    const local = options.filter((o) => o.value.startsWith('lmstudio:')).map((o) => o.value)
    assert.deepEqual(local, ['lmstudio:qwen3-coder-30b'])
  })

  it('keeps every model the server did not flag', async () => {
    // The flag is the only thing that hides a row here; the picker does not
    // second-guess the list it was given.
    const options = await fetchModelOptions(
      mockApi({
        lmStudioModelInfo: [{ id: 'qwen3-coder-30b' }, { id: 'llama-3.3-70b-instruct' }],
      }),
      '',
    )
    const local = options.filter((o) => o.value.startsWith('lmstudio:')).map((o) => o.value)
    assert.deepEqual(local, ['lmstudio:qwen3-coder-30b', 'lmstudio:llama-3.3-70b-instruct'])
  })

  it('still surfaces a flagged model that is the current selection', async () => {
    // Hiding the row would leave the picker showing a value it does not list, so
    // the "not available" fallback below the loop is what the user sees instead.
    const options = await fetchModelOptions(
      mockApi({
        lmStudioModelInfo: [
          { id: 'text-embedding-nomic-embed-text-v1.5', embedding: true },
          { id: 'qwen3-coder-30b' },
        ],
      }),
      'lmstudio:text-embedding-nomic-embed-text-v1.5',
    )
    const row = options.find((o) => o.value === 'lmstudio:text-embedding-nomic-embed-text-v1.5')
    assert.ok(row, 'the current selection must stay visible')
    assert.match(row.label, /not available/i)
  })
})

describe('ACP retention qualification', () => {
  it('qualifies advertised, automatic and saved routes without inferring local/ZDR from names or environment', async () => {
    const agents: AcpAgentConfig[] = [
      {
        id: 'local',
        title: 'Local zero-retention agent',
        command: 'fixture',
        enabled: true,
        env: { OPENAI_BASE_URL: 'http://localhost:1234/v1', OPENAI_API_KEY: 'not-a-real-key' },
        availableModels: [{ value: 'fireworks:model', label: 'Zero retention model' }],
      },
      { id: 'default', title: 'Default agent', command: 'fixture', enabled: true },
      { id: 'disabled', title: 'Disabled agent', command: 'fixture', enabled: false },
    ]
    for (const selected of ['acp:local#retired', 'acp:disabled', 'acp:removed']) {
      const rows = (await fetchModelOptions(mockApi({ acpAgents: agents }), selected)).filter(
        (row) => row.value.startsWith('acp:'),
      )
      assert.ok(rows.some((row) => row.value === 'acp:local#fireworks:model'))
      assert.ok(rows.some((row) => row.value === 'acp:default'))
      assert.ok(rows.some((row) => row.value === selected))
      assert.ok(rows.every((row) => row.retention === ACP_RETENTION_NOTICE))
      assert.match(ACP_RETENTION_NOTICE.detail, /signed-in account and upstream model provider/)
    }
  })
})
