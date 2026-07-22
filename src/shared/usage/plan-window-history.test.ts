import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import {
  PLAN_WINDOW_SAMPLE_MIN_GAP_MS,
  appendPlanWindowSamples,
  completedWindowApiDollars,
  detectCompletedWindows,
  parsePlanWindowHistory,
  samplesFromSnapshot,
  sampleShowsReset,
  windowExhaustionRates,
  type PlanWindowHistorySample,
} from './plan-window-history.ts'

function sample(at: number, windows: PlanWindowHistorySample['windows']): PlanWindowHistorySample {
  return { at, provider: 'claude', planLabel: 'Weekly $50 / $100', windows }
}

describe('samplesFromSnapshot', () => {
  it('keeps dollar fields from ok providers', () => {
    const snapshot: PlanUsageSnapshot = {
      checkedAt: '2026-07-22T00:00:00Z',
      providers: [
        {
          status: 'ok',
          provider: 'claude',
          usage: {
            provider: 'claude',
            plan: 'Weekly $50 / $100',
            checkedAt: '2026-07-22T00:00:00Z',
            windows: [
              {
                id: 'seven_day',
                label: 'Weekly',
                usedPercent: 50,
                resetsAt: '2026-07-25T00:00:00Z',
                usedDollars: 50,
                limitDollars: 100,
              },
            ],
          },
        },
        { status: 'unavailable', provider: 'codex', reason: 'nope' },
      ],
    }
    const samples = samplesFromSnapshot(snapshot, 1_000)
    assert.equal(samples.length, 1)
    const window = samples[0]?.windows[0]
    assert.ok(window)
    assert.equal(window.usedDollars, 50)
    assert.equal(window.limitDollars, 100)
  })
})

describe('detectCompletedWindows / sampleShowsReset', () => {
  const prev = sample(1_000, [
    {
      id: 'seven_day',
      label: 'Weekly',
      usedPercent: 90,
      resetsAt: '2026-07-20T00:00:00Z',
      usedDollars: 90,
      limitDollars: 100,
    },
  ])
  const next = sample(2_000, [
    {
      id: 'seven_day',
      label: 'Weekly',
      usedPercent: 5,
      resetsAt: '2026-07-27T00:00:00Z',
      usedDollars: 5,
      limitDollars: 100,
    },
  ])

  it('detects a reset and finalizes the prior peak', () => {
    assert.equal(sampleShowsReset(prev, next), true)
    const completed = detectCompletedWindows(prev, next)
    assert.equal(completed.length, 1)
    const done = completed[0]
    assert.ok(done)
    assert.equal(done.usedPercent, 90)
    assert.equal(done.usedDollars, 90)
    assert.equal(done.endedResetsAt, '2026-07-20T00:00:00Z')
  })

  it('does not treat a rising used% as a reset', () => {
    const rising = sample(2_000, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 95,
        resetsAt: '2026-07-20T00:00:00Z',
        usedDollars: 95,
        limitDollars: 100,
      },
    ])
    assert.equal(sampleShowsReset(prev, rising), false)
    assert.deepEqual(detectCompletedWindows(prev, rising), [])
  })
})

describe('appendPlanWindowSamples', () => {
  it('rate-limits ordinary samples but always keeps resets', () => {
    const t0 = 1_000_000
    const first = sample(t0, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 80,
        resetsAt: '2026-07-20T00:00:00Z',
        usedDollars: 80,
        limitDollars: 100,
      },
    ])
    const soon = sample(t0 + 60_000, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 85,
        resetsAt: '2026-07-20T00:00:00Z',
        usedDollars: 85,
        limitDollars: 100,
      },
    ])
    const reset = sample(t0 + 120_000, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 2,
        resetsAt: '2026-07-27T00:00:00Z',
        usedDollars: 2,
        limitDollars: 100,
      },
    ])
    let state = appendPlanWindowSamples({ samples: [], completed: [] }, [first], t0)
    state = appendPlanWindowSamples(state, [soon], t0 + 60_000)
    assert.equal(state.samples.length, 1, 'gap too short and no reset')
    const retained = state.samples[0]?.windows[0]
    assert.ok(retained)
    assert.equal(retained.usedDollars, 85, 'gap-skip folds higher peak')
    assert.equal(retained.usedPercent, 85)
    state = appendPlanWindowSamples(state, [reset], t0 + 120_000)
    assert.equal(state.samples.length, 2)
    assert.equal(state.completed.length, 1)
    const done = state.completed[0]
    assert.ok(done)
    assert.equal(done.usedDollars, 85)
    assert.equal(done.usedPercent, 85)

    const laterAt = t0 + 120_000 + PLAN_WINDOW_SAMPLE_MIN_GAP_MS + 1
    const later = sample(laterAt, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 10,
        resetsAt: '2026-07-27T00:00:00Z',
        usedDollars: 10,
        limitDollars: 100,
      },
    ])
    state = appendPlanWindowSamples(state, [later], later.at)
    assert.equal(state.samples.length, 3)
  })
})


describe('appendPlanWindowSamples prior-provider scan', () => {
  it('folds into the latest matching provider when older providers are present', () => {
    const t0 = 2_000_000
    const codex: PlanWindowHistorySample = {
      ...sample(t0, [
        {
          id: 'seven_day',
          label: 'Weekly',
          usedPercent: 10,
          resetsAt: '2026-07-20T00:00:00Z',
          usedDollars: 10,
          limitDollars: 100,
        },
      ]),
      provider: 'codex',
    }
    const claude = sample(t0 + 1_000, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 40,
        resetsAt: '2026-07-20T00:00:00Z',
        usedDollars: 40,
        limitDollars: 100,
      },
    ])
    const claudeSoon = sample(t0 + 30_000, [
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 55,
        resetsAt: '2026-07-20T00:00:00Z',
        usedDollars: 55,
        limitDollars: 100,
      },
    ])
    let state = appendPlanWindowSamples({ samples: [], completed: [] }, [codex, claude], t0 + 1_000)
    assert.equal(state.samples.length, 2)
    state = appendPlanWindowSamples(state, [claudeSoon], t0 + 30_000)
    assert.equal(state.samples.length, 2, 'codex retained; claude gap-folded')
    assert.equal(state.samples[0]?.provider, 'codex')
    assert.equal(state.samples[0]?.windows[0]?.usedDollars, 10)
    assert.equal(state.samples[1]?.provider, 'claude')
    assert.equal(state.samples[1]?.windows[0]?.usedDollars, 55)
  })
})

describe('completedWindowApiDollars / windowExhaustionRates', () => {
  it('prefers usedDollars then percent×limit', () => {
    assert.equal(
      completedWindowApiDollars({
        provider: 'claude',
        windowId: 'seven_day',
        label: 'Weekly',
        usedPercent: 50,
        usedDollars: 40,
        limitDollars: 100,
        endedResetsAt: null,
        completedAt: 1,
      }),
      40,
    )
    assert.equal(
      completedWindowApiDollars({
        provider: 'claude',
        windowId: 'seven_day',
        label: 'Weekly',
        usedPercent: 50,
        limitDollars: 100,
        endedResetsAt: null,
        completedAt: 1,
      }),
      50,
    )
  })

  it('computes exhaustion rates per window id', () => {
    const rates = windowExhaustionRates([
      {
        provider: 'claude',
        windowId: 'seven_day_fable',
        label: 'Weekly Fable',
        usedPercent: 100,
        endedResetsAt: null,
        completedAt: 1,
      },
      {
        provider: 'claude',
        windowId: 'seven_day_fable',
        label: 'Weekly Fable',
        usedPercent: 40,
        endedResetsAt: null,
        completedAt: 2,
      },
      {
        provider: 'claude',
        windowId: 'seven_day',
        label: 'Weekly',
        usedPercent: 20,
        endedResetsAt: null,
        completedAt: 3,
      },
    ])
    assert.deepEqual(rates.get('seven_day_fable'), { hit: 1, total: 2 })
    assert.deepEqual(rates.get('seven_day'), { hit: 0, total: 1 })
  })
})

describe('parsePlanWindowHistory', () => {
  it('drops malformed records', () => {
    const parsed = parsePlanWindowHistory({
      samples: [
        { at: 1 },
        sample(2, [{ id: 'seven_day', label: 'W', usedPercent: 1, resetsAt: null }]),
      ],
      completed: [{ provider: 'claude' }],
    })
    assert.equal(parsed.samples.length, 1)
    assert.equal(parsed.completed.length, 0)
  })
})
