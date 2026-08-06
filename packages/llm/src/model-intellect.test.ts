import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BAND_REPRESENTATIVE_MODEL,
  CANONICAL_INTELLECT_VERSION,
  explainIntellectScore,
  getIntellectScore,
  intellectBand,
  modelIntellect,
  topAnnotatedIntellect,
} from './model-intellect.ts'
import { MODEL_INTELLECT_RAW } from './model-intellect.generated.ts'
import { LOCAL_MODEL_CATALOG } from './local-model-catalog.ts'
import { TRACKED_MODELS } from './model-catalog.ts'

describe('getIntellectScore', () => {
  it('returns the canonical measurement as a fact, not an estimate', () => {
    const score = getIntellectScore('claude-opus-4-8')
    assert.ok(score)
    assert.equal(score.value, 55.7)
    assert.equal(score.estimated, undefined)
    assert.equal(score.measuredBitsPerWeight, 16)
    assert.ok(score.source.length > 10)
    assert.match(score.asOf, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns null for a model with no sourced measurement — absent, never zero', () => {
    assert.equal(getIntellectScore('some-unsourced-model'), null)
    assert.equal(getIntellectScore('made-up-model'), null)
  })

  it('resolves alias and structurally-wrapped forms to the same measurement', () => {
    const direct = getIntellectScore('claude-fable-5')
    assert.ok(direct)
    assert.equal(direct.value, 59.9)
    // ACP picker label, OpenRouter id, provider prefix, option suffix, agent
    // segment, and serving-route tag all resolve to the one measurement.
    assert.deepEqual(getIntellectScore('Fable 5'), direct)
    assert.deepEqual(getIntellectScore('anthropic/claude-fable-5'), direct)
    assert.deepEqual(getIntellectScore('openrouter:anthropic/claude-fable-5'), direct)
    assert.deepEqual(getIntellectScore('claude-fable-5[1m]'), direct)
    assert.deepEqual(getIntellectScore('acp:claude-agent-acp#claude-fable-5[1m]'), direct)
    assert.deepEqual(
      getIntellectScore('huggingface:MiniMaxAI/MiniMax-M3:novita'),
      getIntellectScore('MiniMaxAI/MiniMax-M3'),
    )
    // Wrapper stripping must not invent matches for unknown models.
    assert.equal(getIntellectScore('lmstudio:unknown/model'), null)
    assert.equal(getIntellectScore('acp:cursor#default[]'), null)
  })

  it('prefers a direct canonical measurement over equating a June-cohort reading', () => {
    // MiniMax-M3 carries both a v4.0 reading (55) and a direct v4.1 reading
    // (44.4). The canonical scale is v4.1, so the direct measurement wins as a
    // fact — no equating hop, not flagged estimated.
    const m3 = getIntellectScore('MiniMaxAI/MiniMax-M3')
    assert.ok(m3)
    assert.equal(m3.value, 44.4)
    assert.equal(m3.estimated, undefined)
    const explanation = explainIntellectScore('MiniMaxAI/MiniMax-M3')
    assert.ok(explanation)
    assert.equal(explanation.steps.length, 1)
    assert.equal(explanation.steps[0]?.step, 'measured')
    assert.equal(explanation.steps[0].value, 44.4)
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
    assert.equal(explanation.value, 35.9)
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

describe('model intellect scale', () => {
  it('ranks a tracked model exactly when it has a measurement', () => {
    // The old editorial map guaranteed coverage by forcing a hand-written entry
    // per model. Ranking now follows the measurements instead, so a model that
    // ships ahead of its Intelligence Index reading is simply unranked —
    // `null`, meaning unknown, never a stand-in number. Consumers must treat
    // that as "not a candidate", not as "weakest".
    for (const model of TRACKED_MODELS) {
      assert.equal(modelIntellect(model), getIntellectScore(model)?.value ?? null, model)
    }
  })

  it('reads the measured axis rather than a separate scale', () => {
    for (const model of TRACKED_MODELS) {
      const measured = getIntellectScore(model)
      if (measured) assert.equal(modelIntellect(model), measured.value, model)
    }
  })

  it('returns null for ids nothing has measured or curated', () => {
    assert.equal(modelIntellect('lmstudio:not-a-real-local-model'), null)
    assert.equal(modelIntellect(''), null)
  })

  it('keeps each band representative inside its band as the scale evolves', () => {
    // Static picks, dynamically validated: when a stronger model extends the
    // scale and demotes yesterday's top band, this test fails and forces the
    // representatives to be revisited instead of silently going stale.
    for (const [band, model] of Object.entries(BAND_REPRESENTATIVE_MODEL)) {
      const value = modelIntellect(model)
      assert.ok(value !== null, `${model} must be annotated`)
      assert.equal(intellectBand(value), band, `${model} must sit in the '${band}' band`)
    }
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
