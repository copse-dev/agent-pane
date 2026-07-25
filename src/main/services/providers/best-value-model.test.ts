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
})
