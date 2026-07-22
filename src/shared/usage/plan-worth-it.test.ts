import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computePlanWorthIt,
  hintMonthlyFeeFromWeeklyLimit,
  monthlyFeeToWeekly,
  PLAN_WORTH_IT_MIN_WEEKLY_SAMPLES,
} from './plan-worth-it.ts'
import type { CompletedPlanWindow } from './plan-window-history.ts'

function weekly(usedDollars: number, limitDollars = 100): CompletedPlanWindow {
  return {
    provider: 'claude',
    windowId: 'seven_day',
    label: 'Weekly',
    usedPercent: (usedDollars / limitDollars) * 100,
    usedDollars,
    limitDollars,
    endedResetsAt: '2026-07-20T00:00:00Z',
    completedAt: Date.now(),
  }
}

describe('hintMonthlyFeeFromWeeklyLimit', () => {
  it('maps known weekly dollar bands', () => {
    assert.deepEqual(hintMonthlyFeeFromWeeklyLimit(20), { monthlyFeeUsd: 20, label: 'Pro' })
    assert.deepEqual(hintMonthlyFeeFromWeeklyLimit(100), { monthlyFeeUsd: 100, label: 'Max 5x' })
    assert.deepEqual(hintMonthlyFeeFromWeeklyLimit(200), { monthlyFeeUsd: 200, label: 'Max 20x' })
    assert.equal(hintMonthlyFeeFromWeeklyLimit(55), null)
  })
})

describe('computePlanWorthIt', () => {
  it('asks for more history when fewer than the minimum weekly samples', () => {
    const result = computePlanWorthIt({
      completed: [weekly(90)],
      monthlyFeeUsd: 100,
    })
    assert.equal(result.verdict, 'insufficient_history')
    assert.equal(result.completedWeeklyCount, 1)
  })

  it('asks for a fee when history exists but no fee/hint', () => {
    const result = computePlanWorthIt({
      completed: [weekly(90, 55), weekly(80, 55)],
    })
    assert.equal(result.verdict, 'needs_fee')
    assert.equal(result.monthlyFeeUsd, null)
  })

  it('uses the fee hint from weekly limitDollars when the user has not set a fee', () => {
    const result = computePlanWorthIt({
      completed: [weekly(90), weekly(95)],
      latestClaudeSample: {
        at: 1,
        provider: 'claude',
        planLabel: null,
        windows: [
          {
            id: 'seven_day',
            label: 'Weekly',
            usedPercent: 10,
            resetsAt: null,
            limitDollars: 100,
          },
        ],
      },
    })
    assert.equal(result.feeHint?.label, 'Max 5x')
    assert.equal(result.monthlyFeeUsd, 100)
    assert.equal(result.verdict, 'worth_it')
  })

  it('marks worth_it when burn covers most of the weekly fee', () => {
    const feeWeek = monthlyFeeToWeekly(100)
    const burn = feeWeek * 0.9
    const result = computePlanWorthIt({
      completed: Array.from({ length: PLAN_WORTH_IT_MIN_WEEKLY_SAMPLES }, () => weekly(burn)),
      monthlyFeeUsd: 100,
    })
    assert.equal(result.verdict, 'worth_it')
    assert.match(result.reason, /ahead of paying inference/)
  })

  it('marks not_worth_it when burn is well below the fee', () => {
    const feeWeek = monthlyFeeToWeekly(100)
    const burn = feeWeek * 0.2
    const result = computePlanWorthIt({
      completed: [weekly(burn), weekly(burn)],
      monthlyFeeUsd: 100,
    })
    assert.equal(result.verdict, 'not_worth_it')
    assert.match(result.reason, /inference rates would likely be cheaper/)
  })

  it('marks borderline near break-even', () => {
    const feeWeek = monthlyFeeToWeekly(100)
    const burn = feeWeek * 0.65
    const result = computePlanWorthIt({
      completed: [weekly(burn), weekly(burn)],
      monthlyFeeUsd: 100,
    })
    assert.equal(result.verdict, 'borderline')
  })
})
