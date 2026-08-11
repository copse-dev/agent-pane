// Contract test: the scale-tagged intellect lookup.
//
// The invariants that matter to consumers thresholding on capability:
//  1. A cloud model resolves to its sourced canonical measurement.
//  2. A local weight resolves to the **quant-adjusted** canonical score (flagged
//     estimated), not the full-precision one, and the `lmstudio:` picker prefix
//     resolves to the same entry as the bare weight id.
//  3. The two scales are never blended — a composite value keeps its own tag.
//  4. An unknown model is null ("not sourced"), never zero.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeIntellectScale, resolveModelIntellect } from './intellect-lookup.ts'
import { getIntellectScore, CANONICAL_INTELLECT_VERSION } from './model-intellect.ts'
import { LOCAL_MODEL_CATALOG, localBenchmarkScore } from './local-model-catalog.ts'

describe('resolveModelIntellect', () => {
  it('resolves a tracked cloud model to its canonical measurement', () => {
    const haiku = resolveModelIntellect('claude-haiku-4-5')
    assert.ok(haiku, 'claude-haiku-4-5 carries a sourced measurement')
    assert.equal(haiku.scale, 'canonical')
    assert.equal(haiku.value, getIntellectScore('claude-haiku-4-5')?.value)

    // The frontier end of the same scale, so a threshold between them separates
    // "needs help" from "does not" (the forced-planning plugin's whole premise).
    const fable = resolveModelIntellect('claude-fable-5')
    assert.ok(fable)
    assert.ok(fable.value > haiku.value)
  })

  it('prefers a local weight’s quant-adjusted score and accepts the lmstudio: prefix', () => {
    const local = LOCAL_MODEL_CATALOG.find((m) => m.benchmarks['aa-intelligence'])
    assert.ok(local, 'the shipped catalog has at least one measured local weight')
    const adjusted = localBenchmarkScore(local, 'aa-intelligence')
    assert.ok(adjusted)

    const bare = resolveModelIntellect(local.id)
    assert.deepEqual(bare, {
      value: adjusted.value,
      scale: 'canonical',
      estimated: adjusted.estimated === true,
      basis: adjusted.basis ?? adjusted.source,
    })
    assert.deepEqual(resolveModelIntellect(`lmstudio:${local.id}`), bare)
  })

  it('keeps the composite on its own scale rather than blending rulers', () => {
    // The composite is a weighted mean of 0–100 pass-rate benchmarks; the
    // canonical index is a harder composite where frontier models sit near 60.
    // The labels must stay distinguishable so a consumer can hold one threshold
    // per scale instead of comparing across them.
    assert.match(describeIntellectScale('canonical'), new RegExp(CANONICAL_INTELLECT_VERSION))
    assert.notEqual(describeIntellectScale('canonical'), describeIntellectScale('composite'))
  })

  it('returns null for a model with nothing sourced', () => {
    assert.equal(resolveModelIntellect('totally-unknown-model-9000'), null)
    assert.equal(resolveModelIntellect(''), null)
  })
})
