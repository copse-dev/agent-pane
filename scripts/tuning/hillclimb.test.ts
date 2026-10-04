import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HarborTuning } from '../../src/main/services/container-runtime/harbor-tuning.mts'
import {
  climb,
  formatPlan,
  planClimb,
  renderReport,
  type ClimbOptions,
  type ClimbResult,
  type Evaluator,
} from './hillclimb-lib.mts'
import { MemoryLedger, pendingTrials, trialKey, type LedgerStore } from './ledger.mts'
import { parseSpace } from './space.mts'
import { seededRandom } from './stats.mts'
import { fixtureRecord, syntheticTasks } from './trial-fixtures.mts'

const SCREEN = syntheticTasks(4)
const CONFIRM = syntheticTasks(14).slice(4)
const CANARY = syntheticTasks(18).slice(14)

const space = parseSpace(
  JSON.stringify({
    schemaVersion: 1,
    base: { modelParametersMode: 'server' },
    parameters: [
      {
        id: 'recovery',
        description: 'recovery cap',
        productSeam: {
          file: 'packages/agent/src/reasoning-checkpoint-policy.ts',
          symbol: 'PRODUCT_REASONING_RECOVERY_MAX_TOKENS',
        },
        default: '4096',
        values: [
          { label: '4096', set: { reasoningRecoveryMaxTokens: 4096 } },
          { label: '8192', set: { reasoningRecoveryMaxTokens: 8192 } },
          { label: '12288', set: { reasoningRecoveryMaxTokens: 12288 } },
        ],
      },
      {
        id: 'temperature',
        description: 'temperature',
        productSeam: null,
        default: 'server',
        values: [
          { label: 'server', set: {} },
          { label: '0.6', set: { sampling: { temperature: 0.6 } } },
        ],
      },
    ],
    taskSets: { screen: SCREEN, confirm: CONFIRM, canary: CANARY },
    estimate: { minutesPerTrial: 6.5 },
  }),
  'test space',
)

/** A stable 32-bit hash so a cell's outcome does not depend on when it ran. */
function hash32(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

type World = (tuning: HarborTuning, task: string) => number

interface Counter {
  trials: number
  jobs: number
}

/** A fake evaluator: runs pending cells with outcomes drawn from the world's pass probability. */
function fakeEvaluator(
  store: LedgerStore,
  world: World,
  seed: number,
  counter: Counter,
): Evaluator {
  return (job) => {
    counter.jobs += 1
    const pending = pendingTrials(store.read(), job.configs, job.tasks, job.reps, 2)
    for (const cell of pending) {
      const draw = seededRandom(
        hash32(`${String(seed)}|${trialKey(cell.config.hash, cell.task, cell.rep)}`),
      )()
      store.append(
        fixtureRecord(
          cell.config,
          cell.task,
          cell.rep,
          draw < world(cell.config.tuning, cell.task),
        ),
      )
      counter.trials += 1
    }
    return Promise.resolve()
  }
}

function options(
  store: LedgerStore,
  evaluator: Evaluator,
  overrides: Partial<ClimbOptions> = {},
): ClimbOptions {
  let clock = 0
  return {
    space,
    store,
    evaluator,
    screenReps: 3,
    confirmReps: 3,
    canaryReps: 2,
    neighbours: 'adjacent',
    promoteFraction: 0.5,
    maxTrials: null,
    maxMs: null,
    maxRounds: 4,
    analysis: { iterations: 1500, seed: 5 },
    canaryMaxDrop: 0.5,
    escalate: true,
    maxAttempts: 2,
    now: (): number => {
      clock += 1000
      return clock
    },
    log: (): void => {},
    ...overrides,
  }
}

const hard = (task: string): boolean => !CANARY.includes(task)

/** A bigger recovery cap genuinely fixes the hard tasks; the canaries always pass. */
const improving: World = (tuning, task) => {
  if (!hard(task)) return 1
  return (tuning.reasoningRecoveryMaxTokens ?? 0) >= 8192 ? 0.95 : 0.1
}
/** Every hard task is a coin flip whatever the config does. */
const noisy: World = (_tuning, task) => (hard(task) ? 0.5 : 1)
/** The cap fixes the hard tasks but breaks the canaries. */
const regressing: World = (tuning, task) => {
  const large = (tuning.reasoningRecoveryMaxTokens ?? 0) >= 8192
  if (!hard(task)) return large ? 0.2 : 1
  return large ? 0.95 : 0.1
}

async function runClimb(
  world: World,
  seed: number,
  overrides: Partial<ClimbOptions> = {},
  store: LedgerStore = new MemoryLedger(),
  counter: Counter = { trials: 0, jobs: 0 },
): Promise<{ result: ClimbResult; store: LedgerStore; counter: Counter; opts: ClimbOptions }> {
  const opts = options(store, fakeEvaluator(store, world, seed, counter), overrides)
  return { result: await climb(opts), store, counter, opts }
}

describe('hill climbing with a fake evaluator', () => {
  it('accepts a genuine improvement, then stops when nothing further helps', async () => {
    const { result } = await runClimb(improving, 1)
    const accepted = result.accepted.map((d) => `${d.parameter}:${d.from}->${d.to}`)
    assert.deepEqual(accepted, ['recovery:4096->8192'])
    assert.equal(result.stopReason, 'converged')
    assert.equal(result.finalSelection['recovery'], '8192')
    const decision = result.accepted[0]
    assert.ok(decision?.confirm)
    assert.equal(decision.confirm.verdict, 'better beyond noise')
    assert.equal(decision.canary?.ok, true)
    // The verdict rests on the confirm tasks, which the screen never saw.
    assert.equal(decision.confirm.tasksCompared, CONFIRM.length)
    for (const row of decision.confirm.perTask) assert.ok(CONFIRM.includes(row.task))
  })

  it('rejects noise: identical coin-flip configs are never accepted, across seeds', async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { result } = await runClimb(noisy, seed)
      assert.equal(
        result.accepted.length,
        0,
        `seed ${String(seed)} accepted ${JSON.stringify(result.accepted.map((d) => d.to))}`,
      )
      assert.equal(result.final.id, 'default')
      assert.equal(result.stopReason, 'converged')
    }
  })

  it('rejects a candidate that regresses a canary even when it wins the confirm set', async () => {
    const { result } = await runClimb(regressing, 1)
    assert.equal(result.accepted.length, 0)
    const rejected = result.decisions.find((d) => d.outcome === 'rejected-canary')
    assert.ok(rejected, 'a candidate was rejected for its canary')
    assert.equal(rejected.confirm?.verdict, 'better beyond noise')
    assert.ok(rejected.canary)
    assert.equal(rejected.canary.ok, false)
    assert.ok(rejected.canary.rows.some((row) => row.status === 'regressed'))
  })

  it('does not promote a candidate that loses the screen', async () => {
    const { result } = await runClimb(noisy, 3)
    for (const decision of result.decisions) {
      if (decision.outcome === 'screen-negative') {
        assert.ok((decision.screen?.diff ?? 1) <= 0)
        assert.equal(decision.confirm, null)
      }
    }
  })

  it('escalates an underpowered but positive candidate once, with double the confirm reps', async () => {
    const moderate: World = (tuning, task) => {
      if (!hard(task)) return 1
      return (tuning.reasoningRecoveryMaxTokens ?? 0) >= 8192 ? 0.6 : 0.3
    }
    let escalatedAccepted = 0
    for (let seed = 1; seed <= 30; seed += 1) {
      const { result } = await runClimb(moderate, seed)
      for (const decision of result.decisions.filter((d) => d.escalated)) {
        assert.equal(decision.confirm?.meanRepsCandidate, 6)
        if (decision.outcome === 'accepted') escalatedAccepted += 1
      }
    }
    assert.ok(
      escalatedAccepted > 0,
      'some moderate improvements are confirmed only after escalation',
    )
    const { result } = await runClimb(moderate, 1, { escalate: false })
    for (const decision of result.decisions) assert.equal(decision.escalated, false)
  })

  it('respects a trial budget and stops before a job that would exceed it', async () => {
    const { result, counter } = await runClimb(improving, 1, { maxTrials: 50 })
    assert.equal(result.stopReason, 'budget:trials')
    assert.ok(counter.trials <= 50, `ran ${String(counter.trials)} trials`)
    assert.equal(result.trialsLaunched, counter.trials)
    assert.ok(result.decisions.some((d) => d.outcome === 'skipped-budget'))
  })

  it('respects a wall-clock budget', async () => {
    const { result, counter } = await runClimb(improving, 1, { maxMs: 500 })
    assert.equal(result.stopReason, 'budget:time')
    assert.equal(counter.trials, 0)
  })

  it('resumes: a budget-limited run followed by a fresh run equals one uninterrupted run, with no repeated trials', async () => {
    const uninterrupted = await runClimb(improving, 1)
    const store = new MemoryLedger()
    const counter: Counter = { trials: 0, jobs: 0 }
    const first = await runClimb(improving, 1, { maxTrials: 60 }, store, counter)
    assert.equal(first.result.stopReason, 'budget:trials')
    const second = await runClimb(improving, 1, {}, store, counter)
    assert.equal(second.result.stopReason, 'converged')
    assert.equal(second.result.final.hash, uninterrupted.result.final.hash)
    assert.deepEqual(
      second.result.accepted.map((d) => d.to),
      uninterrupted.result.accepted.map((d) => d.to),
    )
    assert.equal(counter.trials, uninterrupted.counter.trials)
    const keys = store.read().map((r) => trialKey(r.config.hash, r.task, r.rep))
    assert.equal(new Set(keys).size, keys.length, 'no cell ran twice')
    // A third run over a finished ledger launches nothing.
    const third = await runClimb(improving, 1, {}, store, counter)
    assert.equal(third.result.trialsLaunched, 0)
    assert.equal(counter.trials, uninterrupted.counter.trials)
  })
})

describe('planning', () => {
  it('counts round 1 from the schedule, with the incumbent measured once', async () => {
    const store = new MemoryLedger()
    const opts = options(store, fakeEvaluator(store, improving, 1, { trials: 0, jobs: 0 }))
    const plan = planClimb(opts)
    assert.equal(plan.candidates.length, 2)
    assert.equal(plan.promotedWorstCase, 1)
    // screen (1 + 2) x 4 x 3, confirm (1 + 1) x 10 x 3, canary (1 + 1) x 4 x 2
    assert.deepEqual(
      plan.lines.map((line) => line.trials),
      [36, 60, 16],
    )
    assert.equal(plan.trials, 112)
    assert.equal(plan.minutes, 112 * 6.5)
    // Escalating the one promoted candidate adds its confirm reps and the incumbent's.
    assert.equal(plan.worstCaseTrials, 112 + 2 * 10 * 3)
    assert.match(formatPlan(plan, opts), /Round 1 total: 112 trials/)
  })

  it('is resume-aware: measured cells cost nothing', async () => {
    const store = new MemoryLedger()
    await runClimb(improving, 1, { maxRounds: 1 }, store)
    const plan = planClimb(
      options(store, fakeEvaluator(store, improving, 1, { trials: 0, jobs: 0 })),
    )
    assert.equal(plan.trials, 0)
  })
})

describe('report', () => {
  it('lists each accepted change with its evidence table and a PR checklist', async () => {
    const { result, opts } = await runClimb(improving, 1)
    const report = renderReport(result, opts)
    assert.match(report, /## Accepted changes/)
    assert.match(report, /### 1\. recovery: 4096 -> 8192/)
    assert.match(report, /better beyond noise/)
    assert.match(report, /\| task \| candidate \| baseline \| diff \|/)
    assert.match(report, /Canary/)
    assert.match(report, /PR checklist/)
    assert.match(
      report,
      /- \[ \] Change `PRODUCT_REASONING_RECOVERY_MAX_TOKENS` \(packages\/agent\/src\/reasoning-checkpoint-policy\.ts\)/,
    )
    assert.match(report, /separate from this tool/)
  })

  it('says so when nothing was accepted', async () => {
    const { result, opts } = await runClimb(noisy, 1)
    const report = renderReport(result, opts)
    assert.match(report, /None\. The defaults stand/)
    assert.match(report, /Nothing to propose/)
  })
})
