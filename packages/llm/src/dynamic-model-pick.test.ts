import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickDynamicModel } from './dynamic-model-pick.ts'
import {
  computeParetoFrontier,
  type FrontierCandidate,
  type FrontierPoint,
} from './pareto-frontier.ts'
import { minIntellectSelector, parseDynamicModel } from './dynamic-model.ts'

/** Frontier annotation is what the host feeds in; build it the same way here. */
function pool(candidates: readonly FrontierCandidate[]): FrontierPoint[] {
  return computeParetoFrontier(candidates)
}

const CANDIDATES: FrontierCandidate[] = [
  { id: 'tiny-local', intellect: 22, costPerMTok: 0, local: true },
  { id: 'big-local', intellect: 38, costPerMTok: 0, local: true },
  { id: 'mid-cloud', intellect: 46, costPerMTok: 3 },
  { id: 'frontier-cloud', intellect: 61, costPerMTok: 9 },
]

function pick(value: string, candidates: readonly FrontierCandidate[] = CANDIDATES): string | null {
  const selector = parseDynamicModel(value)
  assert.ok(selector, `not a selector: ${value}`)
  return pickDynamicModel(selector, pool(candidates))?.id ?? null
}

describe('pickDynamicModel', () => {
  it('picks the strongest model overall for "most capable"', () => {
    assert.equal(pick('auto:best-intellect'), 'frontier-cloud')
  })

  it('picks the strongest on-device model for "best on-device"', () => {
    assert.equal(pick('auto:best-local'), 'big-local')
  })

  it('falls back to the cheapest reachable route when nothing is loaded locally', () => {
    const cloudOnly = CANDIDATES.filter((c) => c.local !== true)
    assert.equal(pick('auto:best-local', cloudOnly), 'mid-cloud')
  })

  it('prefers the smartest free route for "cheapest" — free models all cost the same', () => {
    assert.equal(pick('auto:cheapest'), 'big-local')
  })

  it('falls back to the lowest price when nothing is free', () => {
    const paid = CANDIDATES.filter((c) => c.local !== true)
    assert.equal(pick('auto:cheapest', paid), 'mid-cloud')
  })

  it('treats a plan-covered model as free', () => {
    const planned: FrontierCandidate[] = [
      { id: 'cheap-api', intellect: 30, costPerMTok: 1 },
      { id: 'on-plan', intellect: 55, costPerMTok: 0, plan: 'Claude Max' },
    ]
    assert.equal(pick('auto:cheapest', planned), 'on-plan')
  })

  describe('minimum intelligence', () => {
    it('takes the cheapest route that clears the bar', () => {
      assert.equal(pick(minIntellectSelector(40)), 'mid-cloud')
    })

    it('prefers a free route that clears the bar over a paid one', () => {
      assert.equal(pick(minIntellectSelector(30)), 'big-local')
    })

    it('falls back to the most capable model when nobody clears the bar', () => {
      // Asking for "at least 90" with a 61-point ceiling is answered with the
      // best available, not with silence or the cheapest.
      assert.equal(pick(minIntellectSelector(90)), 'frontier-cloud')
    })
  })

  it('returns null for an empty pool rather than inventing a model', () => {
    assert.equal(pick('auto:best-intellect', []), null)
  })

  it('does not resolve roles — those are the host’s assignments, not the pool’s', () => {
    assert.equal(pickDynamicModel({ kind: 'role', role: 'coder' }, pool(CANDIDATES)), null)
  })

  it('picks a best-value point even when the pool has no frontier winner', () => {
    // A single dominated-looking candidate still has to resolve to something.
    assert.equal(pick('auto:best-value', [{ id: 'only', intellect: 10, costPerMTok: 4 }]), 'only')
  })
})
