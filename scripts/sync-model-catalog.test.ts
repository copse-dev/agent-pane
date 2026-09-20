import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tierPricingFromEntry } from './sync-model-catalog.mts'

describe('LiteLLM service-tier pricing decode', () => {
  it('keeps a complete zero-priced tier', () => {
    assert.deepEqual(
      tierPricingFromEntry({
        input_cost_per_token_flex: 0,
        output_cost_per_token_flex: 0,
      }),
      { flex: { inputPricePerMTok: 0, outputPricePerMTok: 0 } },
    )
  })

  it('omits incomplete or malformed tiers without affecting other tier data', () => {
    assert.deepEqual(
      tierPricingFromEntry({
        input_cost_per_token_flex: -1,
        output_cost_per_token_flex: 0.000001,
        input_cost_per_token_priority: 0.000002,
        output_cost_per_token_priority: 0.000004,
      }),
      { priority: { inputPricePerMTok: 2, outputPricePerMTok: 4 } },
    )
  })
})
