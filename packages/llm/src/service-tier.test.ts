import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVICE_TIERS,
  SERVICE_TIER_CHOICES,
  isServiceTier,
  serviceTierBody,
} from './service-tier.ts'

describe('serviceTierBody', () => {
  it('adds nothing when no tier is configured', () => {
    assert.deepEqual(serviceTierBody(undefined), {})
    // Spreading the empty result must leave a request untouched.
    assert.deepEqual({ model: 'gpt-5', ...serviceTierBody(undefined) }, { model: 'gpt-5' })
  })

  it('emits every documented tier verbatim', () => {
    for (const tier of SERVICE_TIERS) {
      assert.deepEqual(serviceTierBody(tier), { service_tier: tier })
    }
  })
})

describe('isServiceTier', () => {
  it('accepts exactly the tiers OpenAI documents', () => {
    assert.deepEqual([...SERVICE_TIERS], ['auto', 'default', 'flex', 'priority', 'scale'])
    for (const tier of SERVICE_TIERS) {
      assert.equal(isServiceTier(tier), true)
    }
  })

  it('rejects `fast`, a product name rather than a request value', () => {
    // OpenAI markets Priority processing as "Fast mode", and `llm` exposes it as
    // `-o service_tier fast` — but `fast` is not an API value and produces a 400.
    // An earlier revision passed it through, on the theory that the SDK union
    // lagged the API. It does not: the union matches OpenAI's documented set
    // exactly, so accepting `fast` only steered users into a guaranteed error.
    assert.equal(isServiceTier('fast'), false)
  })

  it('rejects anything else rather than guessing', () => {
    assert.equal(isServiceTier('some-future-tier'), false)
    // A cleared setting reads as '' and must mean "unset", never `service_tier: ""`.
    assert.equal(isServiceTier(''), false)
    // The API is case-sensitive.
    assert.equal(isServiceTier('FLEX'), false)
  })
})

describe('SERVICE_TIER_CHOICES', () => {
  it('offers standard, flex and priority in that order', () => {
    assert.deepEqual(
      SERVICE_TIER_CHOICES.map((c) => c.value),
      ['', 'flex', 'priority'],
    )
  })

  it('only offers values the request layer accepts', () => {
    for (const choice of SERVICE_TIER_CHOICES) {
      // '' is the unset sentinel; everything else must be a real tier.
      assert.equal(choice.value === '' || isServiceTier(choice.value), true)
      assert.ok(choice.label.length > 0)
      assert.ok(choice.description.length > 0)
    }
  })

  it('withholds scale and the standard-processing synonyms', () => {
    const offered = new Set(SERVICE_TIER_CHOICES.map((c) => c.value))
    // `scale` needs committed reserved throughput, so it is not a per-chat toggle.
    assert.equal(offered.has('scale'), false)
    // `auto` and `default` both mean standard processing, which '' already covers.
    assert.equal(offered.has('auto'), false)
    assert.equal(offered.has('default'), false)
  })
})
