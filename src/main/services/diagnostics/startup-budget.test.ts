import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STARTUP_PHASE_BUDGETS,
  findBudgetOverruns,
  formatOverrun,
  formatStartupTimeline,
  reportStartupBudget,
  totalStartupMs,
} from './startup-budget.ts'
import type { PhaseDuration } from './event-loop-watchdog.ts'

const timeline: PhaseDuration[] = [
  { phase: 'app-ready', ms: 0 },
  { phase: 'reap-gortex', ms: 20 },
  { phase: 'tool-availability', ms: 3290 },
  { phase: 'skills-mcp', ms: 6000 },
]

describe('startup-budget', () => {
  it('reports only phases over their budget', () => {
    const overruns = findBudgetOverruns(timeline, [
      { phase: 'tool-availability', budgetMs: 4000 },
      { phase: 'skills-mcp', budgetMs: 5000 },
    ])
    assert.deepEqual(overruns, [{ phase: 'skills-mcp', budgetMs: 5000, actualMs: 6000 }])
  })

  // A phase with no budget entry must pass silently rather than default to some
  // implicit ceiling — a wrong implicit guess is worse than no signal.
  it('ignores phases with no budget', () => {
    assert.deepEqual(findBudgetOverruns(timeline, [{ phase: 'not-a-phase', budgetMs: 1 }]), [])
  })

  it('treats exactly-at-budget as within budget', () => {
    assert.deepEqual(
      findBudgetOverruns(
        [{ phase: 'window-create', ms: 500 }],
        [{ phase: 'window-create', budgetMs: 500 }],
      ),
      [],
    )
  })

  it('sums the whole timeline', () => {
    assert.equal(totalStartupMs(timeline), 9310)
    assert.equal(totalStartupMs([]), 0)
  })

  it('formats a timeline and an overrun readably', () => {
    assert.equal(
      formatStartupTimeline(timeline),
      'app-ready:0ms reap-gortex:20ms tool-availability:3290ms skills-mcp:6000ms',
    )
    assert.equal(
      formatOverrun({ phase: 'skills-mcp', budgetMs: 5000, actualMs: 6000 }),
      'skills-mcp took 6000ms (budget 5000ms)',
    )
  })

  // Shipped budgets must be positive and unique, or a typo silently disables one.
  it('ships a coherent budget table', () => {
    const phases = STARTUP_PHASE_BUDGETS.map((b) => b.phase)
    assert.equal(new Set(phases).size, phases.length, 'duplicate phase budget')
    for (const budget of STARTUP_PHASE_BUDGETS) {
      assert.ok(budget.budgetMs > 0, `${budget.phase} budget must be positive`)
    }
  })

  // This runs at boot-complete. A diagnostic that can throw would turn a slow
  // startup into a failed one.
  it('never throws, even when reading a phase blows up', () => {
    assert.doesNotThrow(() => {
      reportStartupBudget([])
    })

    // A throwing getter satisfies `ms: number` structurally, so this reaches the
    // reporter's try/catch without lying about the type — and it exercises the
    // real hazard (something the reporter reads misbehaving) rather than a shape
    // the signature already rules out. Note `undefined` would be no test at all:
    // a default parameter treats it as "use the default" and runs the happy path.
    const exploding: PhaseDuration = {
      phase: 'boom',
      get ms(): number {
        throw new Error('phase duration unavailable')
      },
    }
    assert.doesNotThrow(() => {
      reportStartupBudget([exploding])
    })
  })
})
