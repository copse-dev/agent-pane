import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TRACKED_MODELS } from './model-catalog.ts'
import {
  MODEL_INTELLECT,
  intellectBand,
  modelIntellect,
  topAnnotatedIntellect,
} from './model-intellect.ts'

describe('model intellect scale', () => {
  it('annotates every tracked model, and nothing else', () => {
    assert.deepEqual(Object.keys(MODEL_INTELLECT).sort(), [...TRACKED_MODELS].sort())
  })

  it('resolves a value for tracked ids and null for unknown/local ids', () => {
    assert.equal(modelIntellect('claude-opus-4-8'), 9)
    assert.equal(modelIntellect('claude-haiku-4-5'), 4)
    assert.equal(modelIntellect('lmstudio:qwen/qwen2.5-coder-32b'), null)
    assert.equal(modelIntellect(''), null)
  })

  it('keeps the scale ordinal: a strictly stronger model has a strictly higher number', () => {
    const haiku = modelIntellect('claude-haiku-4-5') ?? NaN
    const sonnet = modelIntellect('claude-sonnet-4-6') ?? NaN
    const opus = modelIntellect('claude-opus-4-8') ?? NaN
    assert.ok(haiku < sonnet && sonnet < opus)
  })

  it('bands values relative to the annotated distribution', () => {
    const scale = [3, 4, 5, 6, 6, 8, 9]
    assert.equal(intellectBand(9, scale), 'top')
    assert.equal(intellectBand(8, scale), 'top')
    assert.equal(intellectBand(6, scale), 'mid')
    assert.equal(intellectBand(4, scale), 'low')
  })

  it('re-bands automatically when a new frontier model extends the scale', () => {
    // The rot-resistance property: annotating a hypothetical next-generation
    // model at 11 demotes yesterday's 9 out of the top band — no stored data
    // is re-numbered, the bands simply re-derive from the distribution.
    const today = [3, 4, 5, 6, 6, 8, 9]
    assert.equal(intellectBand(9, today), 'top')

    const afterNextFrontier = [...today, 11]
    assert.equal(intellectBand(11, afterNextFrontier), 'top')
    assert.equal(intellectBand(9, afterNextFrontier), 'mid')
    assert.equal(topAnnotatedIntellect(afterNextFrontier), 11)
  })
})
