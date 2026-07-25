import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blendedPricePerMTok,
  computeParetoFrontier,
  costOnAxis,
  frontierForKnownModels,
  pickBestValueFrontierModel,
  projectOntoCostAxis,
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

describe('costOnAxis / projectOntoCostAxis', () => {
  it('keeps blended costs on the blended axis', () => {
    const c: FrontierCandidate = { id: 'm', intellect: 40, costPerMTok: 9, costPerTask: 1.5 }
    assert.equal(costOnAxis(c, 'blended'), 9)
    const { plotted, missingAxisCost } = projectOntoCostAxis([c], 'blended')
    assert.equal(plotted.length, 1)
    const [blendedPoint] = plotted
    assert.ok(blendedPoint)
    assert.equal(blendedPoint.costPerMTok, 9)
    assert.equal(missingAxisCost.length, 0)
  })

  it('plots per-task cost and preserves blended list price for tooltips', () => {
    const c: FrontierCandidate = { id: 'm', intellect: 40, costPerMTok: 9, costPerTask: 1.5 }
    assert.equal(costOnAxis(c, 'perTask'), 1.5)
    const { plotted, missingAxisCost } = projectOntoCostAxis([c], 'perTask')
    assert.equal(missingAxisCost.length, 0)
    const [taskPoint] = plotted
    assert.ok(taskPoint)
    assert.equal(taskPoint.costPerMTok, 1.5)
    assert.equal(taskPoint.blendedCostPerMTok, 9)
    assert.equal(taskPoint.costPerTask, 1.5)
  })

  it('keeps local and plan-included models at $0 on the task axis', () => {
    assert.equal(costOnAxis({ costPerMTok: 0, local: true }, 'perTask'), 0)
    assert.equal(costOnAxis({ costPerMTok: 0, plan: 'Max' }, 'perTask'), 0)
  })

  it('excludes models that lack task cost on the per-task axis', () => {
    const c: FrontierCandidate = { id: 'm', intellect: 40, costPerMTok: 9 }
    assert.equal(costOnAxis(c, 'perTask'), null)
    const { plotted, missingAxisCost } = projectOntoCostAxis([c], 'perTask')
    assert.equal(plotted.length, 0)
    assert.equal(missingAxisCost[0]?.id, 'm')
  })

  it('recomputes dominance on the remapped task-cost axis', () => {
    const points = computeParetoFrontier(
      projectOntoCostAxis(
        [
          { id: 'verbose-cheap-tokens', intellect: 50, costPerMTok: 2, costPerTask: 4 },
          { id: 'terse-pricey-tokens', intellect: 50, costPerMTok: 8, costPerTask: 1 },
        ],
        'perTask',
      ).plotted,
    )
    const byId = new Map(points.map((p) => [p.id, p]))
    assert.equal(byId.get('terse-pricey-tokens')?.onFrontier, true)
    assert.equal(byId.get('verbose-cheap-tokens')?.onFrontier, false)
    assert.equal(byId.get('verbose-cheap-tokens')?.dominatedBy, 'terse-pricey-tokens')
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

  it('filters routes before equivalent model identities are grouped', () => {
    const score = getIntellectScore('gpt-4o')
    assert.ok(score)
    const points = frontierForKnownModels(
      [
        {
          id: 'openrouter:openai/gpt-4o',
          intellect: score.value,
          costPerMTok: 12,
        },
      ],
      undefined,
      (candidate) => candidate.id.startsWith('openrouter:'),
    )
    assert.equal(points.length, 1)
    assert.equal(points[0]?.id, 'openrouter:openai/gpt-4o')
  })
})

describe('pickBestValueFrontierModel', () => {
  it('prefers the smartest free (plan/local) frontier point', () => {
    const points = computeParetoFrontier([
      { id: 'local-ok', intellect: 35, costPerMTok: 0, local: true },
      { id: 'plan-smart', intellect: 58, costPerMTok: 0, plan: 'Weekly' },
      { id: 'paid-smarter', intellect: 62, costPerMTok: 9 },
    ])
    assert.equal(pickBestValueFrontierModel(points)?.id, 'plan-smart')
  })

  it('among paid frontier points maximizes intellect per dollar', () => {
    const points = computeParetoFrontier([
      { id: 'cheap-good', intellect: 40, costPerMTok: 1 },
      { id: 'pricey-great', intellect: 60, costPerMTok: 12 },
    ])
    // 40/1 = 40 value vs 60/12 = 5 — cheap-good wins on value for price.
    assert.equal(pickBestValueFrontierModel(points)?.id, 'cheap-good')
  })

  it('ignores discovery-only and dominated points', () => {
    const points = computeParetoFrontier([
      { id: 'routable', intellect: 50, costPerMTok: 3 },
      { id: 'ghost', intellect: 70, costPerMTok: 10 },
      { id: 'dominated', intellect: 40, costPerMTok: 5 },
    ]).map((p) => (p.id === 'ghost' ? { ...p, discovery: true } : p))
    // ghost is on the frontier but not routable; dominated is off it.
    assert.equal(pickBestValueFrontierModel(points)?.id, 'routable')
  })

  it('returns null when nothing is selectable', () => {
    assert.equal(pickBestValueFrontierModel([]), null)
    assert.equal(
      pickBestValueFrontierModel([
        { id: 'only-discovery', intellect: 50, costPerMTok: 1, onFrontier: true, discovery: true },
      ]),
      null,
    )
  })
})
