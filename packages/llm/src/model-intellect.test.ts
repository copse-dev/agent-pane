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

  it('resolves alias and structurally-wrapped forms to the same measurement', () => {
    const direct = getIntellectScore('claude-fable-5')
    assert.ok(direct)
    assert.equal(direct.value, 60)
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

  it('equates a June-cohort (v4.0) measurement onto the canonical scale as a flagged estimate', () => {
    // MiniMax-M3 was measured at 55 when Opus 4.8 read 61; on the canonical
    // v4.1 scale (Opus = 56) the fitted map translates it to 50 — estimated,
    // and marked extrapolated because 55 sits below the anchor range.
    const m3 = getIntellectScore('MiniMaxAI/MiniMax-M3')
    assert.ok(m3)
    assert.equal(m3.value, 50)
    assert.equal(m3.estimated, true)
    assert.match(m3.basis ?? '', /equated v4\.0→v4\.1/)
    assert.match(m3.basis ?? '', /extrapolated beyond anchor range/)
    // The raw v4.0 fact is untouched — only the canonical projection is derived.
    const explanation = explainIntellectScore('MiniMaxAI/MiniMax-M3')
    assert.ok(explanation)
    assert.equal(explanation.steps[0]?.value, 55)
    assert.equal(explanation.steps[1]?.step, 'equated')
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
