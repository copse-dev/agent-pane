import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PRICING_ENTRIES,
  mergeModelPricing,
  openRouterPricingMap,
  parseModelPricingMap,
} from './model-pricing.ts'

describe('openRouterPricingMap', () => {
  it('keys rates by the `openrouter:` selection the ledger records', () => {
    const map = openRouterPricingMap([
      { id: 'z-ai/glm-5.2', inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 },
    ])
    assert.deepEqual(map, {
      'openrouter:z-ai/glm-5.2': { inputPricePerMTok: 0.4, outputPricePerMTok: 1.6 },
    })
  })

  it('keeps a genuinely free route at zero rather than dropping it', () => {
    const map = openRouterPricingMap([
      { id: 'qwen/qwen3:free', inputPricePerMTok: 0, outputPricePerMTok: 0 },
    ])
    assert.deepEqual(map['openrouter:qwen/qwen3:free'], {
      inputPricePerMTok: 0,
      outputPricePerMTok: 0,
    })
  })

  it('skips rows the catalog did not price, so they stay unpriced not free', () => {
    const map = openRouterPricingMap([
      { id: 'vendor/unpriced', inputPricePerMTok: null, outputPricePerMTok: null },
      { id: 'vendor/half-priced', inputPricePerMTok: 1, outputPricePerMTok: null },
    ])
    assert.deepEqual(Object.keys(map), [])
  })

  it('carries caching rates through when the route bills them', () => {
    const map = openRouterPricingMap([
      {
        id: 'anthropic/claude-sonnet-4.6',
        inputPricePerMTok: 3,
        outputPricePerMTok: 15,
        cacheReadPricePerMTok: 0.3,
        cacheCreationPricePerMTok: 3.75,
      },
    ])
    assert.deepEqual(map['openrouter:anthropic/claude-sonnet-4.6'], {
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
      cacheReadPricePerMTok: 0.3,
      cacheCreationPricePerMTok: 3.75,
    })
  })
})

describe('mergeModelPricing', () => {
  it('lets a later source win and ignores absent ones', () => {
    const merged = mergeModelPricing(
      { 'openrouter:a': { inputPricePerMTok: 1, outputPricePerMTok: 2 } },
      undefined,
      { 'openrouter:a': { inputPricePerMTok: 9, outputPricePerMTok: 9 } },
      { 'huggingface:b': { inputPricePerMTok: 0.6, outputPricePerMTok: 2.2 } },
    )
    assert.equal(merged['openrouter:a']?.inputPricePerMTok, 9)
    assert.equal(merged['huggingface:b']?.outputPricePerMTok, 2.2)
  })
})

describe('parseModelPricingMap', () => {
  it('drops malformed entries instead of throwing on a corrupt cache', () => {
    const parsed = parseModelPricingMap({
      'openrouter:good': { inputPricePerMTok: 1, outputPricePerMTok: 2 },
      'openrouter:negative': { inputPricePerMTok: -1, outputPricePerMTok: 2 },
      'openrouter:string': { inputPricePerMTok: '1', outputPricePerMTok: 2 },
      'openrouter:missing-output': { inputPricePerMTok: 1 },
      'openrouter:not-an-object': 3,
    })
    assert.deepEqual(Object.keys(parsed), ['openrouter:good'])
  })

  it('returns an empty map for non-record input', () => {
    assert.deepEqual(parseModelPricingMap(null), {})
    assert.deepEqual(parseModelPricingMap([1, 2]), {})
  })

  it('caps the number of entries it will read back', () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < MAX_PRICING_ENTRIES + 50; i += 1) {
      raw[`openrouter:model-${String(i)}`] = { inputPricePerMTok: 1, outputPricePerMTok: 1 }
    }
    assert.equal(Object.keys(parseModelPricingMap(raw)).length, MAX_PRICING_ENTRIES)
  })
})
