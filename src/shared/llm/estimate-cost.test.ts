import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateUsageCost, formatThreadUsageCost, costForModelUsage } from './estimate-cost.ts'

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

  it('prices cache-read cheaper than fresh input for Anthropic models', () => {
    const freshOnly = costForModelUsage('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    const cacheHeavy = costForModelUsage('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    })
    assert.equal(freshOnly, 3)
    assert.equal(cacheHeavy, 0.3)
    assert.ok(cacheHeavy < freshOnly)
  })

  it('prices extra-provider models from the supplied rate map (e.g. HF)', () => {
    const cost = estimateUsageCost(
      {
        'huggingface:zai-org/GLM-5.2:together': { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
      {
        'huggingface:zai-org/GLM-5.2:together': { inputPricePerMTok: 0.6, outputPricePerMTok: 2.2 },
      },
    )
    assert.equal(cost, '~$2.80')
  })

  it('treats an extra-provider model with no known rate as unpriced, not free', () => {
    assert.equal(
      estimateUsageCost({
        'huggingface:org/model:together': { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      '',
    )
  })

  it('passes the rate map through formatThreadUsageCost byModel breakdown', () => {
    assert.equal(
      formatThreadUsageCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          byModel: { 'huggingface:m:p': { inputTokens: 1_000_000, outputTokens: 0 } },
        },
        'claude-sonnet-4-6',
        { 'huggingface:m:p': { inputPricePerMTok: 10, outputPricePerMTok: 20 } },
      ),
      '~$10.00',
    )
  })
})
