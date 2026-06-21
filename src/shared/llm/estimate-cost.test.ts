import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateUsageCost, formatThreadUsageCost } from './estimate-cost.ts'

describe('estimateUsageCost', () => {
  it('prices cloud models only', () => {
    const cost = estimateUsageCost({
      'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 0 },
      'lmstudio:qwen': { inputTokens: 500_000, outputTokens: 200_000 },
    })
    assert.equal(cost, '~$3.00 (+ local free)')
  })

  it('prices Opus 4.8 at the current $5 / $25 per MTok rate', () => {
    const cost = estimateUsageCost({
      'claude-opus-4-8': { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    assert.equal(cost, '~$30.00')
  })

  it('returns free for all-local usage', () => {
    assert.equal(
      estimateUsageCost({ 'lmstudio:local': { inputTokens: 50_000, outputTokens: 10_000 } }),
      'free (local)',
    )
  })

  it('formats legacy thread usage via fallback chat model', () => {
    assert.equal(
      formatThreadUsageCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'claude-sonnet-4-6'),
      '~$3.00',
    )
  })
})
