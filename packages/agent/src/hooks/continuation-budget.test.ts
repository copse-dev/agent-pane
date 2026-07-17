import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { asTurnTreeId } from './turn-tree.ts'
import {
  ContinuationLedger,
  DEFAULT_CONTINUATION_BUDGET,
  canContinue,
  clampLoopLimit,
  remainingBudget,
  tightenLocalCap,
} from './continuation-budget.ts'

// Contract tests for decision 5 (the unified auto-continuation budget), house
// style of permission-platform.test.ts. See docs/plans/hooks-and-feature-packs.md.

describe('continuation budget (decision 5)', () => {
  it('default cap is 5', () => {
    assert.equal(DEFAULT_CONTINUATION_BUDGET, 5)
  })

  it('remainingBudget / canContinue track the shared cap and never go negative', () => {
    assert.equal(remainingBudget(0), 5)
    assert.equal(remainingBudget(5), 0)
    assert.equal(remainingBudget(7), 0, 'never negative')
    assert.equal(canContinue(4), true)
    assert.equal(canContinue(5), false)
  })

  it('budget-ledger increments (decision 5): tryGrant grants machine turns up to the cap, then holds', () => {
    const ledger = new ContinuationLedger()
    const id = asTurnTreeId('tree-1')

    const grants: boolean[] = []
    for (let i = 0; i < DEFAULT_CONTINUATION_BUDGET + 2; i++) grants.push(ledger.tryGrant(id))

    // Exactly `cap` grants succeed (first-come in completion order), then held.
    assert.deepEqual(grants, [true, true, true, true, true, false, false])
    assert.equal(ledger.used(id), 5)
    assert.equal(ledger.remaining(id), 0)
  })

  it('counts are per turn tree — one exhausted tree does not starve another', () => {
    const ledger = new ContinuationLedger()
    const a = asTurnTreeId('tree-a')
    const b = asTurnTreeId('tree-b')
    for (let i = 0; i < 5; i++) ledger.tryGrant(a)

    assert.equal(ledger.tryGrant(a), false, 'a is exhausted')
    assert.equal(ledger.tryGrant(b), true, 'b has its own fresh budget')
    assert.equal(ledger.used(b), 1)
  })

  it('local caps are tighteners inside the shared cap (3/2/2)', () => {
    // Fresh turn tree: each mechanism gets its own local cap while budget remains.
    assert.equal(tightenLocalCap(3, 0), 3, 'closeout 3 when 5 remain')
    assert.equal(tightenLocalCap(2, 0), 2, 'pre-review 2 when 5 remain')
    // As the shared budget is spent, the local cap can only lower.
    assert.equal(tightenLocalCap(2, 4), 1, 'remediation 2 tightened to 1 when only 1 remains')
    assert.equal(tightenLocalCap(2, 5), 0, 'nothing left once the shared cap is hit')
    assert.equal(tightenLocalCap(3, 3), 2, 'closeout 3 tightened to 2 when 2 remain')
  })

  it('effectiveLocalCap on the ledger reflects spent budget', () => {
    const ledger = new ContinuationLedger()
    const id = asTurnTreeId('tree-1')
    assert.equal(ledger.effectiveLocalCap(id, 3), 3)
    ledger.tryGrant(id)
    ledger.tryGrant(id)
    ledger.tryGrant(id)
    ledger.tryGrant(id) // 4 used, 1 remaining
    assert.equal(ledger.effectiveLocalCap(id, 3), 1, 'closeout cap 3 tightened to remaining 1')
    assert.equal(ledger.effectiveLocalCap(id, 2), 1)
  })

  it('loop_limit clamps to min(limit, remaining); null clamps to global with a warning', () => {
    // Numeric loop_limit: min(limit, remaining).
    assert.deepEqual(clampLoopLimit(3, 0), { limit: 3, clampedFromNull: false })
    assert.deepEqual(
      clampLoopLimit(10, 0),
      { limit: 5, clampedFromNull: false },
      'bounded to remaining',
    )
    assert.deepEqual(
      clampLoopLimit(3, 3),
      { limit: 2, clampedFromNull: false },
      'bounded to remaining 2',
    )

    // null (unlimited) is clamped to the global remaining and warns.
    const nullClamp = clampLoopLimit(null, 0)
    assert.equal(nullClamp.limit, 5)
    assert.equal(nullClamp.clampedFromNull, true)
    assert.match(nullClamp.warning ?? '', /unlimited/)
    assert.match(nullClamp.warning ?? '', /human-in-the-loop/)

    // A null clamp against an exhausted budget yields 0 (never negative).
    assert.equal(clampLoopLimit(null, 5).limit, 0)
  })

  it('ledger.clampLoopLimit reads the turn tree spent count', () => {
    const ledger = new ContinuationLedger()
    const id = asTurnTreeId('tree-1')
    ledger.tryGrant(id) // 1 used, 4 remaining
    assert.equal(ledger.clampLoopLimit(id, 10).limit, 4)
    assert.equal(ledger.clampLoopLimit(id, null).clampedFromNull, true)
  })

  it('seed shares one counter across surfaces (renderer drains → main tighteners); monotonic', () => {
    const ledger = new ContinuationLedger()
    const id = asTurnTreeId('tree-1')
    // The renderer already spent 3 queue-drain continuations before this run.
    ledger.seed(id, 3)
    assert.equal(ledger.used(id), 3)
    assert.equal(ledger.effectiveLocalCap(id, 3), 2, 'closeout 3 tightened to remaining 2')

    ledger.seed(id, 1) // stale/lower seed never lowers the live count
    assert.equal(ledger.used(id), 3)
  })

  it('forget drops the counter — a human action starts a fresh turn tree with reset budget', () => {
    const ledger = new ContinuationLedger()
    const id = asTurnTreeId('tree-1')
    for (let i = 0; i < 5; i++) ledger.tryGrant(id)
    assert.equal(ledger.tryGrant(id), false)

    ledger.forget(id)
    assert.equal(ledger.used(id), 0, 'reset budget after a human-initiated fresh turn tree')
    assert.equal(ledger.tryGrant(id), true)
  })
})
