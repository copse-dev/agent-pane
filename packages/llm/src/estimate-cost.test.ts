import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateUsageCost,
  formatThreadUsageCost,
  costForModelUsage,
  costForModelUsageWithDetails,
  hasZeroModelPricing,
} from './estimate-cost.ts'

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

  it('distinguishes an explicitly free cloud route from an unpriced route', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 }
    assert.equal(
      estimateUsageCost(
        { 'openrouter:vendor/free': usage },
        {
          'openrouter:vendor/free': {
            inputPricePerMTok: 0,
            outputPricePerMTok: 0,
          },
        },
      ),
      'free',
    )
    assert.equal(estimateUsageCost({ 'openrouter:vendor/unknown': usage }), '')
  })

  it('marks a known cost as partial when another used model is unpriced', () => {
    assert.equal(
      estimateUsageCost({
        'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 0 },
        'openrouter:vendor/unknown': { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      '~$3.00 (partial)',
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

  it('prices mixed standard, flex, and priority turns for one model independently', () => {
    const cost = costForModelUsage(
      'openrouter:vendor/tiered',
      {
        inputTokens: 3_000_000,
        outputTokens: 3_000_000,
        serviceTierUsage: {
          flex: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          priority: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        },
      },
      {
        'openrouter:vendor/tiered': {
          inputPricePerMTok: 10,
          outputPricePerMTok: 20,
          serviceTierPricing: {
            flex: { inputPricePerMTok: 5, outputPricePerMTok: 10 },
            priority: { inputPricePerMTok: 20, outputPricePerMTok: 40 },
          },
        },
      },
    )
    // Standard: $30, flex: $15, priority: $60. Applying one latest tier to
    // all 3M tokens would be materially wrong.
    assert.equal(cost, 105)
  })

  it('uses tier cache rates rather than falling back to standard cache prices', () => {
    const cost = costForModelUsage(
      'openrouter:vendor/tiered-cache',
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        serviceTierUsage: {
          flex: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
        },
      },
      {
        'openrouter:vendor/tiered-cache': {
          inputPricePerMTok: 10,
          outputPricePerMTok: 20,
          cacheReadPricePerMTok: 1,
          serviceTierPricing: {
            flex: { inputPricePerMTok: 5, outputPricePerMTok: 10, cacheReadPricePerMTok: 0.5 },
          },
        },
      },
    )
    assert.equal(cost, 0.5)
  })

  it('marks a missing tier price when explicitly falling back to standard pricing', () => {
    const result = costForModelUsageWithDetails(
      'openrouter:vendor/no-flex-price',
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        serviceTierUsage: { flex: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      },
      {
        'openrouter:vendor/no-flex-price': { inputPricePerMTok: 10, outputPricePerMTok: 20 },
      },
    )
    assert.deepEqual(result, { costUsd: 30, tierPricingFallback: true })
    assert.equal(
      estimateUsageCost(
        {
          'openrouter:vendor/no-flex-price': {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            serviceTierUsage: { flex: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
          },
        },
        {
          'openrouter:vendor/no-flex-price': { inputPricePerMTok: 10, outputPricePerMTok: 20 },
        },
      ),
      '~$30.00 (standard tier fallback)',
    )
  })

  it('keeps a published zero tier rate distinct from a missing tier price', () => {
    const result = costForModelUsageWithDetails(
      'openrouter:vendor/free-flex',
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        serviceTierUsage: { flex: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      },
      {
        'openrouter:vendor/free-flex': {
          inputPricePerMTok: 10,
          outputPricePerMTok: 20,
          serviceTierPricing: { flex: { inputPricePerMTok: 0, outputPricePerMTok: 0 } },
        },
      },
    )
    assert.deepEqual(result, { costUsd: 0, tierPricingFallback: false })
  })
})

describe('local-free and zero-rate wording', () => {
  it('leaves off "(+ local free)" when the caller explains local usage itself', () => {
    const byModel = {
      'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 0 },
      'lmstudio:qwen': { inputTokens: 1_000, outputTokens: 0 },
    }
    assert.equal(estimateUsageCost(byModel), '~$3.00 (+ local free)')
    assert.equal(estimateUsageCost(byModel, undefined, { localFreeExplained: true }), '~$3.00')
  })

  it('tells an explicit zero-rate route from an unpriced or paid one', () => {
    const pricing = {
      'openrouter:vendor/free': { inputPricePerMTok: 0, outputPricePerMTok: 0 },
      'openrouter:vendor/paid': { inputPricePerMTok: 1, outputPricePerMTok: 2 },
    }
    assert.equal(hasZeroModelPricing('openrouter:vendor/free', pricing), true)
    assert.equal(hasZeroModelPricing('openrouter:vendor/paid', pricing), false)
    assert.equal(hasZeroModelPricing('openrouter:vendor/unknown', pricing), false)
    assert.equal(hasZeroModelPricing('lmstudio:qwen', pricing), false)
  })
})
