import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  analyzeLedger,
  compareConfigs,
  dataRequirement,
  formatAnalysis,
  outcomesByTask,
  replicateNoise,
  summarizeConfig,
} from './analysis.mts'
import { makeConfig } from './configs.mts'
import type { TrialRecord } from './ledger.mts'
import { seededRandom } from './stats.mts'
import { fixtureRecord, syntheticTasks } from './trial-fixtures.mts'

const baseline = makeConfig('default', { reasoningRecoveryMaxTokens: 4096 })
const candidate = makeConfig('hc-test', { reasoningRecoveryMaxTokens: 8192 })
const FAST = { iterations: 2000, seed: 11 }

/** Records for `config` where task i passes `passes[i]` of `reps` reps. */
function ledgerFor(
  config: typeof baseline,
  tasks: readonly string[],
  reps: number,
  passes: readonly number[],
): TrialRecord[] {
  const records: TrialRecord[] = []
  tasks.forEach((task, index) => {
    for (let rep = 1; rep <= reps; rep += 1) {
      records.push(fixtureRecord(config, task, rep, rep <= (passes[index] ?? 0)))
    }
  })
  return records
}

describe('verdicts', () => {
  const tasks = syntheticTasks(12)

  it('calls a genuine improvement better beyond noise', () => {
    // Six tasks go from 0/3 to 3/3; six are solved by both.
    const records = [
      ...ledgerFor(baseline, tasks, 3, [0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3]),
      ...ledgerFor(candidate, tasks, 3, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]),
    ]
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'better beyond noise')
    assert.equal(result.diff, 0.5)
    assert.ok(result.ci.lo > 0)
    assert.equal(result.tasksCompared, 12)
  })

  it('calls the mirror image worse beyond noise', () => {
    const records = [
      ...ledgerFor(candidate, tasks, 3, [0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3]),
      ...ledgerFor(baseline, tasks, 3, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]),
    ]
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'worse beyond noise')
    assert.ok(result.ci.hi < 0)
  })

  it('never calls a win from one rep per task', () => {
    const records = [
      ...ledgerFor(baseline, tasks, 1, new Array<number>(12).fill(0)),
      ...ledgerFor(candidate, tasks, 1, new Array<number>(12).fill(1)),
    ]
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'underpowered')
    assert.equal(result.tasksCompared, 0)
    assert.match(result.reason, /2 valid reps in both configs/)
    assert.equal(result.tasksExcluded.length, 12)
  })

  it('is underpowered below the minimum number of tasks, however large the effect', () => {
    const few = syntheticTasks(5)
    const records = [
      ...ledgerFor(baseline, few, 4, new Array<number>(5).fill(0)),
      ...ledgerFor(candidate, few, 4, new Array<number>(5).fill(4)),
    ]
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'underpowered')
    assert.match(result.reason, /at least 8 are required/)
    assert.ok(result.requirement !== null)
  })

  it('reports no detectable difference when a narrow interval rules out the effect of interest', () => {
    const records = [
      ...ledgerFor(baseline, tasks, 3, new Array<number>(12).fill(3)),
      ...ledgerFor(candidate, tasks, 3, new Array<number>(12).fill(3)),
    ]
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'no detectable difference')
    assert.equal(result.requirement, null)
  })

  it('does not credit a flip-heavy configuration, and says how much more data it would take', () => {
    // Every task is a coin flip for both configs: identical code, large run-to-run noise.
    const random = seededRandom(2026)
    const records: TrialRecord[] = []
    for (const config of [baseline, candidate]) {
      for (const task of tasks) {
        for (let rep = 1; rep <= 4; rep += 1) {
          records.push(fixtureRecord(config, task, rep, random() < 0.5))
        }
      }
    }
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'underpowered')
    assert.ok(result.noiseFloor95 > 0.1, `noise floor ${String(result.noiseFloor95)}`)
    const requirement = result.requirement
    assert.ok(requirement !== null)
    assert.ok(requirement.tasksNeeded > result.tasksCompared)
    assert.ok(requirement.additionalTasks > 100)
    const summary = summarizeConfig(records, baseline.hash)
    assert.ok(summary.noise.flipShare >= 0.5, `flip share ${String(summary.noise.flipShare)}`)
  })

  it('refuses a verdict when the effect is inside the replicate noise floor', () => {
    // A real +0.1 shift on top of heavy flipping, which twelve tasks cannot resolve.
    const random = seededRandom(7)
    const records: TrialRecord[] = []
    for (const [config, p] of [
      [baseline, 0.5],
      [candidate, 0.6],
    ] as const) {
      for (const task of tasks) {
        for (let rep = 1; rep <= 3; rep += 1) {
          records.push(fixtureRecord(config, task, rep, random() < p))
        }
      }
    }
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    // Observed +0.083 with a noise floor of 0.23: not a win, and the report says what would settle it.
    assert.equal(result.verdict, 'underpowered')
    assert.ok(Math.abs(result.diff) < result.noiseFloor95)
    assert.ok((result.requirement?.additionalTasks ?? 0) > 0)
  })

  it('excludes invalid trials from every statistic but keeps them countable', () => {
    const records = [
      ...ledgerFor(baseline, tasks, 3, new Array<number>(12).fill(0)),
      // The candidate "passed" everything, but every trial was invalid.
      ...ledgerFor(candidate, tasks, 3, new Array<number>(12).fill(3)).map((record) => ({
        ...record,
        valid: false,
        invalidReasons: ['exception:RuntimeError'],
      })),
    ]
    assert.equal(outcomesByTask(records, candidate.hash).size, 0)
    const summary = summarizeConfig(records, candidate.hash)
    assert.equal(summary.validTrials, 0)
    assert.equal(summary.invalidTrials, 36)
    assert.equal(summary.pooled.n, 0)
    const result = compareConfigs(records, candidate.hash, baseline.hash, FAST)
    assert.equal(result.verdict, 'underpowered')
  })

  it('takes the latest valid record when a cell was retried', () => {
    const first = fixtureRecord(baseline, 't01', 1, false, { valid: false, invalidReasons: ['x'] })
    const retry = fixtureRecord(baseline, 't01', 1, true)
    assert.deepEqual([...(outcomesByTask([first, retry], baseline.hash).get('t01') ?? [])], [1])
  })
})

describe('replicate noise', () => {
  it('matches hand-computed values', () => {
    // Task A: 1 0 1 0 has unbiased variance 1/3 over 4 reps; task B: 1 1 1 1 has none.
    const outcomes = new Map([
      ['A', [1, 0, 1, 0]],
      ['B', [1, 1, 1, 1]],
      ['C', [1]],
    ])
    const noise = replicateNoise(outcomes)
    assert.equal(noise.tasksReplicated, 2)
    assert.equal(noise.flippedTasks, 1)
    assert.equal(noise.flipShare, 0.5)
    // sqrt(2 * (1/3 / 4)) / 2 = sqrt(1/6) / 2
    assert.ok(Math.abs(noise.runToRunSd - Math.sqrt(1 / 6) / 2) < 1e-12)
    assert.ok(Math.abs(noise.noiseFloor95 - (1.959964 * Math.sqrt(1 / 6)) / 2) < 1e-9)
  })

  it('is zero when nothing was replicated', () => {
    const noise = replicateNoise(new Map([['A', [1]]]))
    assert.equal(noise.tasksReplicated, 0)
    assert.equal(noise.runToRunSd, 0)
  })
})

describe('data requirement', () => {
  it('computes tasks needed from the observed spread, and says when reps cannot help', () => {
    // Per-task differences 1, 0, 1, 0: SD = sqrt(1/3). Detecting 0.1 at 80% power needs
    // (2.8016 * 0.57735 / 0.1)^2 = 261.7 -> 262 tasks.
    const rows = [1, 0, 1, 0].map((diff) => ({ diff, noiseVarPerRep: 0, reps: 3 }))
    const requirement = dataRequirement(rows, 0.1)
    assert.ok(requirement !== null)
    assert.equal(requirement.tasksNeeded, 262)
    assert.equal(requirement.additionalTasks, 258)
    assert.equal(requirement.repsPerTaskNeeded, null)
  })

  it('finds a finite number of reps when the spread is mostly rep noise', () => {
    // Per-task differences all 0 observed, but each task flips: variance is noise, so
    // more reps on the same tasks do help.
    const rows = Array.from({ length: 10 }, (_, index) => ({
      diff: index % 2 === 0 ? 0.2 : -0.2,
      noiseVarPerRep: 0.5,
      reps: 2,
    }))
    const requirement = dataRequirement(rows, 0.1)
    assert.ok(requirement !== null)
    assert.ok(requirement.repsPerTaskNeeded === null || requirement.repsPerTaskNeeded > 2)
  })

  it('has nothing to say with fewer than two tasks', () => {
    assert.equal(dataRequirement([{ diff: 1, noiseVarPerRep: 0, reps: 3 }], 0.1), null)
  })
})

describe('ledger-wide analysis', () => {
  it('summarizes each config and compares against the default baseline', () => {
    const tasks = syntheticTasks(8)
    const records = [
      ...ledgerFor(baseline, tasks, 2, [0, 0, 0, 0, 2, 2, 2, 2]),
      ...ledgerFor(candidate, tasks, 2, [2, 2, 2, 2, 2, 2, 2, 2]),
    ]
    const analysis = analyzeLedger(records, FAST)
    assert.equal(analysis.baseline, baseline.hash)
    assert.equal(analysis.configs.length, 2)
    const summary = analysis.configs.find((config) => config.hash === baseline.hash)
    assert.ok(summary)
    assert.equal(summary.pooled.passes, 8)
    assert.equal(summary.pooled.n, 16)
    assert.equal(summary.meanAgentSeconds, 300)
    assert.equal(analysis.comparisons.length, 1)
    const text = formatAnalysis(analysis)
    assert.match(text, /Wilson 95%/)
    assert.match(text, /hc-test vs default/)
  })
})
