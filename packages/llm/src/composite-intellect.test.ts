import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPOSITE_INTELLECT_VERSION,
  COMPOSITE_WEIGHTS,
  MIN_COMPOSITE_AXES,
  compositeIntellect,
} from './composite-intellect.ts'
import {
  LOCAL_MODEL_CATALOG,
  localBenchmarkScore,
  type Benchmark,
  type LocalModelCapability,
} from './local-model-catalog.ts'

function fixtureModel(benchmarks: LocalModelCapability['benchmarks']): LocalModelCapability {
  return {
    id: 'test/fixture',
    label: 'Fixture',
    paramsB: 32,
    quant: 'Q4_K_M',
    downloadGb: 19,
    bestForRoles: ['coder'],
    benchmarks,
  }
}

const score = (value: number): { value: number; source: string; asOf: string } => ({
  value,
  source: 'test fixture source string',
  asOf: '2026-01-01',
})

describe('compositeIntellect', () => {
  it('excludes non-pass-rate and canonical axes from the weight table', () => {
    assert.equal(COMPOSITE_WEIGHTS['arena' as Benchmark], undefined)
    assert.equal(COMPOSITE_WEIGHTS['aa-intelligence' as Benchmark], undefined)
  })

  it('needs at least MIN_COMPOSITE_AXES sourced axes', () => {
    const twoAxes = fixtureModel({
      'aider-edit': score(70),
      'humaneval-plus': score(85),
    })
    assert.equal(compositeIntellect(twoAxes), null)
  })

  it('computes a disclosed, weighted mean over sourced axes', () => {
    const model = fixtureModel({
      'swe-bench': score(40), // weight 1.5
      'aider-edit': score(70), // weight 1
      'humaneval-plus': score(85), // weight 0.75
    })
    const composite = compositeIntellect(model)
    assert.ok(composite)
    // (40·1.5 + 70·1 + 85·0.75) / 3.25 = 193.75 / 3.25 ≈ 59.6
    assert.equal(composite.value, 59.6)
    assert.equal(composite.version, COMPOSITE_INTELLECT_VERSION)
    assert.equal(composite.estimated, true)
    assert.deepEqual(composite.axes, ['swe-bench', 'aider-edit', 'humaneval-plus'])
    assert.match(composite.basis, /weighted mean of 3\//)
    assert.match(composite.basis, /swe-bench 40×1\.5/)
  })

  it('defers to a canonical intellect measurement when one exists', () => {
    const model = fixtureModel({
      'aa-intelligence': score(50),
      'swe-bench': score(40),
      'aider-edit': score(70),
      'humaneval-plus': score(85),
    })
    assert.equal(compositeIntellect(model), null)
  })

  it('uses quant-adjusted axis values, disclosing estimates', () => {
    const model = fixtureModel({
      'swe-bench': { ...score(40), measuredBitsPerWeight: 16 },
      'aider-edit': { ...score(70), measuredBitsPerWeight: 16 },
      'humaneval-plus': { ...score(85), measuredBitsPerWeight: 16 },
    })
    const composite = compositeIntellect(model)
    assert.ok(composite)
    // Every input was full-precision, so every input is quant-adjusted down.
    const adjusted = localBenchmarkScore(model, 'swe-bench')
    assert.ok(adjusted?.estimated)
    assert.ok(composite.value < 59.6)
    assert.match(composite.basis, /\(est\.\)/)
  })

  it('is deterministic over the real catalog and never throws', () => {
    for (const model of LOCAL_MODEL_CATALOG) {
      const a = compositeIntellect(model)
      const b = compositeIntellect(model)
      assert.deepEqual(a, b, model.id)
      if (a) assert.ok(a.axes.length >= MIN_COMPOSITE_AXES, model.id)
    }
  })
})
