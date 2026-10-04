import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  createModelInvalidationService,
  type ModelInvalidationEnvironment,
  modelInvalidationReason,
} from './model-invalidation.ts'
import { runWithExplicitSettings } from '../storage/settings-context.ts'
import { clearProviderKeyStatusCache } from './provider-key-status.ts'
import { invalidateLmStudioModelsCache } from './provider-selection.ts'

const CODER = 'qwen/qwen3.6-35b-a3b'
function fixture(): {
  env: ModelInvalidationEnvironment
  service: ReturnType<typeof createModelInvalidationService>
  values: Record<string, string>
  changeRevision: () => void
} {
  const values: Record<string, string> = { model: 'missing:model', research: 'missing:research' }
  let revision = 0
  const env: ModelInvalidationEnvironment = {
    saved: () => [
      {
        target: 'model',
        label: 'Chat default',
        model: values['model'] ?? '',
        role: 'coder',
        replace: async (expected, next, unchanged): Promise<boolean> => {
          if (values['model'] !== expected || !unchanged()) return false
          values['model'] = next
          return true
        },
      },
      {
        target: 'role:research',
        label: 'Research',
        model: values['research'] ?? '',
        role: 'research',
        replace: async (expected, next, unchanged): Promise<boolean> => {
          if (values['research'] !== expected || !unchanged()) return false
          values['research'] = next
          return true
        },
      },
    ],
    reason: async (model): Promise<string | null> =>
      model.startsWith('missing:') ? 'The provider was removed.' : null,
    localModels: async () => [{ id: CODER, local: true }],
    revision: () => String(revision),
  }
  return {
    env,
    service: createModelInvalidationService(env),
    values,
    changeRevision: (): void => {
      revision++
    },
  }
}

describe('main-owned saved model recovery', () => {
  it('includes persisted defaults and roles without a chat, and only offers a role-capable local fallback', async () => {
    const f = fixture()
    const result = await f.service.list()
    assert.deepEqual(
      result.map((item) => [item.target, item.fallback]),
      [
        ['model', `lmstudio:${CODER}`],
        ['role:research', undefined],
      ],
    )
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), true)
    assert.equal(f.values['model'], `lmstudio:${CODER}`)
    assert.equal(f.values['research'], 'missing:research')
  })
  it('re-probes the local catalogue on dismissal rather than accepting a cached model', async () => {
    const f = fixture()
    const probes: boolean[] = []
    f.env.localModels = async (fresh): ReturnType<ModelInvalidationEnvironment['localModels']> => {
      probes.push(fresh === true)
      return fresh ? [] : [{ id: CODER, local: true }]
    }
    assert.equal((await f.service.list())[0]?.fallback, `lmstudio:${CODER}`)
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), false)
    assert.equal(f.values['model'], 'missing:model')
    assert.deepEqual(probes, [false, true])
  })
  it('reports positively verified choices separately from transient unknown evidence', async () => {
    const f = fixture()
    f.env.reason = async (): Promise<string | null> => null
    f.env.verified = async (): Promise<boolean> => false
    const unknown = await f.service.report('unknown:thread')
    assert.equal(unknown.evaluated, true)
    assert.equal(unknown.selections.length, 3)
    assert.deepEqual(unknown.invalidations, [])
    assert.deepEqual(unknown.verifiedChoices, [])
    f.env.verified = async (): Promise<boolean> => true
    assert.equal((await f.service.report('verified:thread')).verifiedChoices.length, 3)
    f.env.verified = async (): Promise<boolean> => {
      f.changeRevision()
      return true
    }
    assert.equal((await f.service.report()).evaluated, false)
  })
  it('excludes automatic and intentionally empty slots', async () => {
    const f = fixture()
    f.values['model'] = 'auto:best-value'
    f.values['research'] = ''
    assert.deepEqual(await f.service.list(), [])
  })
  it('never substitutes unknown, remote or embedding models', async () => {
    for (const model of [
      { id: CODER, local: false },
      { id: 'unknown', local: true },
      { id: CODER, local: true, embedding: true },
    ]) {
      const f = fixture()
      f.env.localModels = async (): ReturnType<ModelInvalidationEnvironment['localModels']> => [
        model,
      ]
      assert.ok((await f.service.list()).every((item) => !item.fallback))
      assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${model.id}`), false)
    }
  })
  it('rejects arbitrary target keys and cloud replacements even for invalid settings', async () => {
    const f = fixture()
    assert.equal(
      await f.service.recover('autoRunSandboxCommands', 'missing:model', `lmstudio:${CODER}`),
      false,
    )
    assert.equal(await f.service.recover('model', 'missing:model', 'claude-opus-4-8'), false)
  })
  it('preserves subsequent user choices and repaired providers', async () => {
    const f = fixture()
    f.values['model'] = 'user:choice'
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), false)
    f.values['model'] = 'missing:model'
    f.env.reason = async (): Promise<string | null> => null
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), false)
  })
  it('drops snapshots if provider configuration changes during a probe', async () => {
    const f = fixture()
    f.env.reason = async (): Promise<string | null> => {
      f.changeRevision()
      return 'Missing.'
    }
    assert.deepEqual(await f.service.list(), [])
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), false)
  })
  it('rechecks configuration inside the atomic persistence callback', async () => {
    const f = fixture()
    const original = f.env.saved
    f.env.saved = (): ReturnType<ModelInvalidationEnvironment['saved']> =>
      original().map((candidate) => ({
        ...candidate,
        replace: async (expected, next, unchanged): Promise<boolean> => {
          f.changeRevision()
          return candidate.replace(expected, next, unchanged)
        },
      }))
    assert.equal(await f.service.recover('model', 'missing:model', `lmstudio:${CODER}`), false)
    assert.equal(f.values['model'], 'missing:model')
  })
  it('includes an invalid concrete active route separately from the default', async () => {
    const f = fixture()
    const result = await f.service.list('missing:thread')
    assert.equal(result[0]?.target, 'thread')
    assert.equal(result[0]?.model, 'missing:thread')
    assert.equal(result.length, 3)
  })
})

describe('conclusive provider change evidence', () => {
  let previousMock: string | undefined
  let previousFetch: typeof fetch
  beforeEach(() => {
    previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '0'
    previousFetch = globalThis.fetch
    clearProviderKeyStatusCache()
    invalidateLmStudioModelsCache()
  })
  afterEach(() => {
    if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
    else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    globalThis.fetch = previousFetch
  })
  it('detects missing built-in/API credentials and removed custom providers', async () => {
    for (const model of [
      'claude-sonnet-4-6',
      'gpt-5-mini',
      'openrouter:vendor/model',
      'remote-agent:cursor',
      'missing-custom:model',
    ]) {
      const reason = await runWithExplicitSettings({ values: {}, apiKeys: {} }, () =>
        modelInvalidationReason(model),
      )
      assert.match(reason ?? '', /no configured API key|provider was removed/)
    }
  })
  it('does not treat a reachable custom local endpoint as requiring a cloud key', async () => {
    const reason = await runWithExplicitSettings(
      {
        values: {
          extraProviders: [
            {
              slug: 'custom-local',
              label: 'Local',
              baseUrl: 'http://127.0.0.1:1234/v1',
              models: [{ id: 'model' }],
            },
          ],
        },
        apiKeys: {},
      },
      () => modelInvalidationReason('custom-local:model'),
    )
    assert.equal(reason, null)
  })
  it('distinguishes actual credential rejection from outage or rate limiting', async () => {
    for (const status of [401, 403, 429, 500]) {
      clearProviderKeyStatusCache()
      globalThis.fetch = async (): Promise<Response> => new Response(null, { status })
      const reason = await runWithExplicitSettings(
        { values: {}, apiKeys: { openai: 'sk-fixture' } },
        () => modelInvalidationReason('gpt-5-mini'),
      )
      if (status === 401 || status === 403) assert.match(reason ?? '', /rejected/)
      else assert.equal(reason, null)
    }
  })
  it('identifies removed/disabled device agents and verified advertised-model retirement', async () => {
    const agent = { id: 'fixture', title: 'Fixture', command: 'fixture-acp', enabled: false }
    assert.match(
      (await runWithExplicitSettings({ values: {} }, () =>
        modelInvalidationReason('acp:fixture'),
      )) ?? '',
      /removed/,
    )
    assert.match(
      (await runWithExplicitSettings({ values: { registeredAcpAgents: [agent] } }, () =>
        modelInvalidationReason('acp:fixture'),
      )) ?? '',
      /disabled/,
    )
    assert.equal(
      await runWithExplicitSettings(
        { values: { registeredAcpAgents: [{ ...agent, enabled: true }] } },
        () => modelInvalidationReason('acp:fixture#unknown'),
      ),
      null,
    )
    assert.match(
      (await runWithExplicitSettings(
        {
          values: {
            registeredAcpAgents: [
              { ...agent, enabled: true, availableModels: [], modelsProbedAt: 1 },
            ],
          },
        },
        () => modelInvalidationReason('acp:fixture#old'),
      )) ?? '',
      /no longer advertises/,
    )
  })
  it('checks pinned local-model retirement only against a successful catalogue', async () => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: [{ id: CODER }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    assert.equal(
      await runWithExplicitSettings({ values: {} }, () =>
        modelInvalidationReason(`lmstudio:${CODER}`),
      ),
      null,
    )
    assert.match(
      (await runWithExplicitSettings({ values: {} }, () =>
        modelInvalidationReason('lmstudio:retired'),
      )) ?? '',
      /no longer offers/,
    )
    invalidateLmStudioModelsCache()
    globalThis.fetch = async (): Promise<Response> => {
      throw new Error('offline')
    }
    assert.equal(
      await runWithExplicitSettings({ values: {} }, () =>
        modelInvalidationReason('lmstudio:retired'),
      ),
      null,
    )
  })
  it('recognizes removed ChatGPT account access without exposing credentials', async () => {
    assert.match(
      (await modelInvalidationReason('chatgpt-plan:missing-account#gpt-5')) ?? '',
      /disconnected/,
    )
  })
  it('honors documented mock mode without probing credentials', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    assert.equal(await modelInvalidationReason('missing-custom:model'), null)
  })
})
