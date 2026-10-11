import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDynamicModelId, resolveDistinctDynamicModelIds } from './dynamic-model.ts'
import { setSetting } from '../storage/settings.ts'
import { computeParetoFrontier, type FrontierPoint } from '@copse/llm/pareto-frontier.ts'
import { FALLBACK_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'

/** A stand-in for the live routable pool, so no test touches the network. */
const POOL: FrontierPoint[] = computeParetoFrontier([
  { id: 'qwen/qwen3.6-35b-a3b', intellect: 38, costPerMTok: 0, local: true },
  { id: 'claude-sonnet-4-6', intellect: 46, costPerMTok: 4 },
  { id: 'claude-opus-4-8', intellect: 61, costPerMTok: 9 },
])

describe('resolveDynamicModelId', () => {
  it('uses best value without assessment for auxiliary prompt-selector consumers', async () => {
    assert.equal(
      await resolveDynamicModelId('auto:match-prompt', { pool: POOL }),
      await resolveDynamicModelId('auto:best-value', { pool: POOL }),
    )
  })
  beforeEach(async () => {
    await setSetting('roleModels', {})
  })

  it('passes a pinned model id straight through', async () => {
    assert.equal(await resolveDynamicModelId('claude-opus-4-8', { pool: POOL }), 'claude-opus-4-8')
    assert.equal(await resolveDynamicModelId('', { pool: POOL }), '')
  })

  it('passes through an auto: value this build cannot parse', async () => {
    // Better to hand a provider something the user actually wrote (and fail
    // loudly) than to quietly substitute a model they never chose.
    const value = 'auto:something-newer'
    assert.equal(await resolveDynamicModelId(value, { pool: POOL }), value)
  })

  it('routes a local winner through the lmstudio: namespace', async () => {
    assert.equal(
      await resolveDynamicModelId('auto:best-local', { pool: POOL }),
      'lmstudio:qwen/qwen3.6-35b-a3b',
    )
  })

  it('resolves the capability selectors against the pool', async () => {
    assert.equal(
      await resolveDynamicModelId('auto:best-intellect', { pool: POOL }),
      'claude-opus-4-8',
    )
    assert.equal(
      await resolveDynamicModelId('auto:min-intellect:40', { pool: POOL }),
      'claude-sonnet-4-6',
    )
  })

  it('falls back to a runnable model when the pool is empty', async () => {
    assert.equal(
      await resolveDynamicModelId('auto:best-intellect', { pool: [] }),
      FALLBACK_APP_CHAT_MODEL,
    )
  })

  it('refuses a paid fallback for balanced with no usage charges', async () => {
    await assert.rejects(
      resolveDynamicModelId('auto:balanced-included', {
        pool: [{ id: 'openrouter:paid', intellect: 53, costPerMTok: 4, onFrontier: true }],
      }),
      /no available local, subscription-covered, or zero-priced model/,
    )
    await assert.rejects(
      resolveDynamicModelId('auto:balanced-included', { pool: [] }),
      /no available local, subscription-covered, or zero-priced model/,
    )
  })

  it('keeps ACP Astra available for chat but excludes it from automatic workers', async () => {
    const pool = computeParetoFrontier([
      { id: 'acp:codex-acp#gpt-6-astra', intellect: 80, costPerMTok: 0 },
      { id: 'lmstudio:qwen/qwen3.6-35b-a3b', intellect: 38, costPerMTok: 0, local: true },
    ])
    assert.equal(
      await resolveDynamicModelId('auto:best-value', { pool }),
      'acp:codex-acp#gpt-6-astra',
    )
    assert.equal(
      await resolveDynamicModelId('auto:best-value', { pool, callableOnly: true }),
      'lmstudio:qwen/qwen3.6-35b-a3b',
    )
    // Soft exclusions must never reintroduce an incompatible route.
    assert.equal(
      await resolveDynamicModelId('auto:best-value', {
        pool,
        callableOnly: true,
        exclude: ['lmstudio:qwen/qwen3.6-35b-a3b'],
      }),
      'lmstudio:qwen/qwen3.6-35b-a3b',
    )
  })

  it('does not silently replace a pinned ACP worker with an API model', async () => {
    const model = 'acp:codex-acp#gpt-6-astra'
    assert.equal(await resolveDynamicModelId(model, { pool: POOL, callableOnly: true }), model)
  })

  describe('roles', () => {
    it('returns the model assigned to the role', async () => {
      await setSetting('roleModels', { advisor: 'claude-opus-4-8' })
      assert.equal(
        await resolveDynamicModelId('auto:role:advisor', { pool: POOL }),
        'claude-opus-4-8',
      )
    })

    it('follows a role assigned to another rule', async () => {
      await setSetting('roleModels', { advisor: 'auto:best-local' })
      assert.equal(
        await resolveDynamicModelId('auto:role:advisor', { pool: POOL }),
        'lmstudio:qwen/qwen3.6-35b-a3b',
      )
    })

    it('falls back to best value when the role has no assignment', async () => {
      const resolved = await resolveDynamicModelId('auto:role:reviewer', { pool: POOL })
      assert.equal(resolved, 'lmstudio:qwen/qwen3.6-35b-a3b')
    })

    it('does not loop forever on a role that points at itself', async () => {
      await setSetting('roleModels', { advisor: 'auto:role:advisor' })
      const resolved = await resolveDynamicModelId('auto:role:advisor', { pool: POOL })
      assert.ok(resolved.length > 0)
    })
  })

  describe('exclusions', () => {
    it('skips an excluded model', async () => {
      assert.equal(
        await resolveDynamicModelId('auto:best-intellect', {
          pool: POOL,
          exclude: ['claude-opus-4-8'],
        }),
        'claude-sonnet-4-6',
      )
    })

    it('ignores exclusions rather than resolving to nothing', async () => {
      // A duplicate model degrades the feature that asked; no model breaks it.
      const resolved = await resolveDynamicModelId('auto:best-intellect', {
        pool: POOL,
        exclude: POOL.map((point) => point.id).concat('lmstudio:qwen/qwen3.6-35b-a3b'),
      })
      assert.equal(resolved, 'claude-opus-4-8')
    })
  })
})

describe('resolveDistinctDynamicModelIds', () => {
  beforeEach(async () => {
    await setSetting('roleModels', {})
  })

  it('never repeats a model when the same rule is used twice', async () => {
    // The model-comparison case: reviewer B and the judge both ask for the most
    // capable model, and must not both get it.
    const resolved = await resolveDistinctDynamicModelIds(
      ['auto:best-intellect', 'auto:best-intellect', 'auto:best-intellect'],
      { pool: POOL },
    )
    assert.equal(new Set(resolved).size, 3)
    assert.deepEqual(resolved, [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'lmstudio:qwen/qwen3.6-35b-a3b',
    ])
  })

  it('gives the unconstrained pick to the first entry', async () => {
    const [first] = await resolveDistinctDynamicModelIds(['auto:best-value', 'auto:best-value'], {
      pool: POOL,
    })
    assert.equal(first, await resolveDynamicModelId('auto:best-value', { pool: POOL }))
  })

  it('steers a later rule away from an earlier pinned id', async () => {
    const resolved = await resolveDistinctDynamicModelIds(
      ['claude-opus-4-8', 'auto:best-intellect'],
      { pool: POOL },
    )
    assert.deepEqual(resolved, ['claude-opus-4-8', 'claude-sonnet-4-6'])
  })

  it('leaves pinned ids exactly as written, colliding or not', async () => {
    // An explicit duplicate is the user's own choice; distinctness is a rule
    // about *rules*, not an override of what someone typed.
    const resolved = await resolveDistinctDynamicModelIds(['claude-opus-4-8', 'claude-opus-4-8'], {
      pool: POOL,
    })
    assert.deepEqual(resolved, ['claude-opus-4-8', 'claude-opus-4-8'])
  })

  it('keeps the entries distinct under the mock-LLM short circuit too', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      const resolved = await resolveDistinctDynamicModelIds([
        'auto:best-value',
        'auto:best-intellect',
        'auto:best-intellect',
      ])
      assert.equal(new Set(resolved).size, 3)
    } finally {
      delete process.env['COPSE_PANEL_MOCK_LLM']
    }
  })
})
