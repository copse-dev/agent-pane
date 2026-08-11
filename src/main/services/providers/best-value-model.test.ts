import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBestValueFromFrontier } from './best-value-model.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'

describe('resolveBestValueFromFrontier', () => {
  it('routes a local winner with the lmstudio: prefix', () => {
    const picked = resolveBestValueFromFrontier(
      [{ id: 'qwen/qwen2.5-coder-32b', intellect: 40, costPerMTok: 0, local: true }],
      null,
    )
    assert.equal(picked, 'lmstudio:qwen/qwen2.5-coder-32b')
  })

  it('prefers a plan-covered cloud model over a paid alternative', () => {
    const snapshot: PlanUsageSnapshot = {
      checkedAt: '2026-07-22T00:00:00Z',
      providers: [
        {
          provider: 'claude',
          status: 'ok',
          usage: {
            provider: 'claude',
            plan: 'Max',
            checkedAt: '2026-07-22T00:00:00Z',
            windows: [
              {
                id: 'seven_day',
                label: 'Weekly',
                usedPercent: 10,
                resetsAt: null,
              },
            ],
          },
        },
      ],
    }
    const picked = resolveBestValueFromFrontier(
      [{ id: 'openrouter:openai/gpt-4o', intellect: 48, costPerMTok: 6 }],
      snapshot,
      (c) => c.id === 'claude-sonnet-4-6' || c.id.startsWith('openrouter:'),
    )
    // claude-sonnet-4-6 comes from the tracked catalog; plan coverage drops it to $0.
    assert.equal(picked, 'claude-sonnet-4-6')
  })

  it('returns null when keepRoute excludes every candidate', () => {
    assert.equal(
      resolveBestValueFromFrontier(
        [{ id: 'openrouter:openai/gpt-4o', intellect: 48, costPerMTok: 6 }],
        null,
        () => false,
      ),
      null,
    )
  })

  it('excludes a batch-only OpenRouter route from the interactive pool', () => {
    const picked = resolveBestValueFromFrontier(
      [
        { id: 'openrouter:minimax/minimax-m3:batch', intellect: 60, costPerMTok: 1 },
        { id: 'openrouter:openai/gpt-4o', intellect: 48, costPerMTok: 6 },
      ],
      null,
      (c) => c.id.startsWith('openrouter:'),
    )
    // `:batch` is async-only; the value pick falls through to the sync route.
    assert.equal(picked, 'openrouter:openai/gpt-4o')
  })

  it("keeps a non-OpenRouter model whose id ends in :batch (not OpenRouter's convention)", () => {
    const picked = resolveBestValueFromFrontier(
      [{ id: 'custom:somemodel:batch', intellect: 60, costPerMTok: 1 }],
      null,
      (c) => c.id.startsWith('custom:'),
    )
    // The gated filter only drops openrouter: ids; this provider's `:batch` is
    // its own model name, so it stays a valid sync pick.
    assert.equal(picked, 'custom:somemodel:batch')
  })

  it('prefers a plan Claude ACP agent over the same model via OpenRouter for best value', () => {
    const snapshot: PlanUsageSnapshot = {
      checkedAt: '2026-07-22T00:00:00Z',
      providers: [
        {
          provider: 'claude',
          status: 'ok',
          usage: {
            provider: 'claude',
            plan: 'Max',
            checkedAt: '2026-07-22T00:00:00Z',
            windows: [
              { id: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 10, resetsAt: null },
              { id: 'seven_day', label: 'Weekly', usedPercent: 5, resetsAt: null },
              { id: 'five_hour', label: '5h', usedPercent: 0, resetsAt: null },
            ],
          },
        },
      ],
    }
    // ACP agent running Opus 5 (plan-covered) vs the same model via OpenRouter.
    const picked = resolveBestValueFromFrontier(
      [
        { id: 'openrouter:anthropic/claude-opus-5', intellect: 61, costPerMTok: 9 },
        { id: 'acp:claude-agent-acp#claude-opus-5', intellect: 61, costPerMTok: 9, plan: 'Claude' },
      ],
      snapshot,
      (c) => c.id.startsWith('openrouter:') || c.id.startsWith('acp:'),
    )
    assert.equal(picked, 'acp:claude-agent-acp#claude-opus-5')
  })
})
