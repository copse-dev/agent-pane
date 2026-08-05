import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SERVICE_TIERS, isServiceTier, serviceTierBody } from './service-tier.ts'

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
