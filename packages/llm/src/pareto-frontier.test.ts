import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blendedPricePerMTok,
  computeParetoFrontier,
  frontierForKnownModels,
  type FrontierCandidate,
} from './pareto-frontier.ts'
import { getModelInfo } from './model-catalog.ts'
import { getIntellectScore } from './model-intellect.ts'

describe('blendedPricePerMTok', () => {
  it('reproduces the published 80/20 blended price for Opus 4.8', () => {
    const info = getModelInfo('claude-opus-4-8')
    assert.ok(info)
    // $5 in / $25 out → 0.8·5 + 0.2·25 = $9/MTok, matching Artificial
    // Analysis' published blended price for the model.
    assert.equal(blendedPricePerMTok(info), 9)
  })
})

describe('computeParetoFrontier', () => {
  const candidates: FrontierCandidate[] = [
    { id: 'cheap-smart', intellect: 50, costPerMTok: 2 },
    { id: 'pricey-smarter', intellect: 60, costPerMTok: 9 },
    { id: 'pricey-dumber', intellect: 45, costPerMTok: 9 },
    { id: 'mid', intellect: 50, costPerMTok: 5 },
  ]

  it('keeps only undominated points on the frontier and names the dominator', () => {
    const points = computeParetoFrontier(candidates)
    const byId = new Map(points.map((p) => [p.id, p]))
    assert.equal(byId.get('cheap-smart')?.onFrontier, true)
    assert.equal(byId.get('pricey-smarter')?.onFrontier, true)
    assert.equal(byId.get('pricey-dumber')?.onFrontier, false)
    // Dominated by the equal-cost, higher-intellect candidate.
    assert.equal(byId.get('pricey-dumber')?.dominatedBy, 'pricey-smarter')
    // Same intellect at a higher price is dominated.
    assert.equal(byId.get('mid')?.onFrontier, false)
    assert.equal(byId.get('mid')?.dominatedBy, 'cheap-smart')
  })

  it('returns points sorted by cost then intellect for plotting', () => {
    const points = computeParetoFrontier(candidates)
    assert.deepEqual(
      points.map((p) => p.id),
      ['cheap-smart', 'mid', 'pricey-smarter', 'pricey-dumber'],
    )
  })

  it('handles free local models as the leftmost frontier point', () => {
    const points = computeParetoFrontier([
      { id: 'local', intellect: 30, costPerMTok: 0, local: true },
      ...candidates,
    ])
    const [first] = points
    assert.ok(first)
    assert.equal(first.id, 'local')
    assert.equal(first.onFrontier, true)
  })

  it('marks exact ties as dominated so duplicates cannot widen the frontier', () => {
    const points = computeParetoFrontier([
      { id: 'b-twin', intellect: 50, costPerMTok: 2 },
      { id: 'a-twin', intellect: 50, costPerMTok: 2 },
    ])
    const [first, second] = points
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.id, 'a-twin')
    assert.equal(first.onFrontier, true)
    assert.equal(second.onFrontier, false)
    assert.equal(second.dominatedBy, 'a-twin')
  })

  it('is deterministic and empty-safe', () => {
    assert.deepEqual(computeParetoFrontier([]), [])
    const a = computeParetoFrontier(candidates)
    const b = computeParetoFrontier([...candidates].reverse())
    assert.deepEqual(a, b)
  })
})

describe('frontierForKnownModels', () => {
  it('includes only tracked models with both pricing and a sourced intellect score', () => {
    const points = frontierForKnownModels()
    assert.ok(points.length > 0)
    for (const p of points) {
      assert.ok(Number.isFinite(p.intellect))
      assert.ok(p.costPerMTok > 0)
      // Every plotted intellect is a sourced measurement, never invented: it must
      // match what getIntellectScore reports for the same id.
      assert.equal(p.intellect, getIntellectScore(p.id)?.value, p.id)
    }
  })

  it('merges caller-supplied local candidates', () => {
    const points = frontierForKnownModels([
      { id: 'lmstudio:test', intellect: 40, costPerMTok: 0, local: true },
    ])
    const [first] = points
    assert.ok(first)
    assert.equal(first.id, 'lmstudio:test')
    assert.equal(first.onFrontier, true)
  })
})
