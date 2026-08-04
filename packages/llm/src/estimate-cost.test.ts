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
  })

  it('prices OpenRouter selections from the supplied rate map', () => {
    // Regression: `openrouter:` ids match neither the static cloud catalog nor
    // the extra-provider slug namespace, so before the pricing map was unified
    // every OpenRouter turn silently estimated at $0.
    const cost = estimateUsageCost(
      { 'openrouter:z-ai/glm-5.2': { inputTokens: 2_000_000, outputTokens: 100_000 } },
      { 'openrouter:z-ai/glm-5.2': { inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 } },
    )
    assert.equal(cost, '~$0.96')
  })

  it('leaves a model with no known rate unpriced rather than guessing', () => {
    assert.equal(
      costForModelUsage('openrouter:vendor/unknown', {
        inputTokens: 5_000_000,
        outputTokens: 1_000_000,
      }),
      0,
    )
  })

  it('applies supplied cache rates to a non-catalog model', () => {
    const cost = costForModelUsage(
      'openrouter:anthropic/claude-sonnet-4.6',
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
      {
        'openrouter:anthropic/claude-sonnet-4.6': {
          inputPricePerMTok: 3,
          outputPricePerMTok: 15,
          cacheReadPricePerMTok: 0.3,
        },
      },
    )
    assert.equal(cost, 0.3)
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
