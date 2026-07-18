import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANONICAL_INTELLECT_VERSION,
  explainIntellectScore,
  getIntellectScore,
} from './model-intellect.ts'
import { MODEL_INTELLECT_RAW } from './model-intellect.generated.ts'
import { LOCAL_MODEL_CATALOG } from './local-model-catalog.ts'

describe('getIntellectScore', () => {
  it('returns the canonical measurement as a fact, not an estimate', () => {
    const score = getIntellectScore('claude-opus-4-8')
    assert.ok(score)
    assert.equal(score.value, 56)
    assert.equal(score.estimated, undefined)
    assert.equal(score.measuredBitsPerWeight, 16)
    assert.ok(score.source.length > 10)
    assert.match(score.asOf, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns null for a model with no sourced measurement — absent, never zero', () => {
    assert.equal(getIntellectScore('gpt-4o'), null)
    assert.equal(getIntellectScore('made-up-model'), null)
  })

  it('every synced measurement carries a citation and version', () => {
    for (const [modelId, entries] of Object.entries(MODEL_INTELLECT_RAW)) {
      for (const m of entries) {
        assert.ok(Number.isFinite(m.value), `${modelId}: value`)
        assert.ok(m.indexVersion.length > 0, `${modelId}: indexVersion`)
        assert.ok(m.source.length > 10, `${modelId}: source`)
        assert.match(m.asOf, /^\d{4}-\d{2}-\d{2}$/, `${modelId}: asOf`)
      }
    }
  })
})

describe('explainIntellectScore', () => {
  it('derives a canonical measurement in one cited step', () => {
    const explanation = explainIntellectScore('claude-sonnet-4-6')
    assert.ok(explanation)
    assert.equal(explanation.value, 47)
    assert.equal(explanation.estimated, false)
    assert.match(explanation.scale, new RegExp(CANONICAL_INTELLECT_VERSION.replace('.', '\\.')))
    assert.equal(explanation.steps.length, 1)
    const [step] = explanation.steps
    assert.ok(step)
    assert.equal(step.step, 'measured')
    assert.match(step.detail, /Artificial Analysis/)
  })

  it('matches getIntellectScore for every model with a measurement', () => {
    for (const modelId of Object.keys(MODEL_INTELLECT_RAW)) {
      const score = getIntellectScore(modelId)
      const explanation = explainIntellectScore(modelId)
      assert.ok(score, modelId)
      assert.ok(explanation, modelId)
      assert.equal(explanation.value, score.value, modelId)
      assert.equal(explanation.estimated, score.estimated === true, modelId)
    }
  })

  it('returns null when there is nothing to explain', () => {
    assert.equal(explainIntellectScore('made-up-model'), null)
  })
})

describe('catalog merge', () => {
  it('rides the aa-intelligence axis into any local model with a measurement', () => {
    for (const model of LOCAL_MODEL_CATALOG) {
      const merged = model.benchmarks['aa-intelligence']
      const direct = getIntellectScore(model.id)
      if (direct) {
        assert.deepEqual(merged, direct, model.id)
      } else {
        assert.equal(merged, undefined, model.id)
      }
    }
  })
})
