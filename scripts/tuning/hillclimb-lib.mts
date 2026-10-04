/**
 * Coordinate ascent with successive halving over the declared parameter space.
 *
 * Each round starts from the incumbent and proposes one-parameter neighbours:
 *
 *   1. screen   every candidate with the incumbent, interleaved, on the small
 *               discriminating task set (k reps) - a point estimate only;
 *   2. promote  the best half (at most, and only those that beat the incumbent) to
 *   3. confirm  on a wider, disjoint task set, with a canary set of easy tasks;
 *   4. accept   a candidate only when the analyzer says `better beyond noise` on the
 *               confirm set and no canary regressed.
 *
 * The verdict is decided on tasks the screen never saw, so choosing a winner from the
 * screen cannot inflate it. Every measurement goes through the ledger and is cached
 * there, which makes the whole climb resumable: re-running replays the same decisions
 * for free and continues where the budget stopped it.
 */
import {
  compareConfigs,
  formatComparison,
  outcomesByTask,
  type AnalysisOptions,
  type Comparison,
} from './analysis.mts'
import type { ResolvedConfig } from './configs.mts'
import { pendingTrials, type LedgerStore } from './ledger.mts'
import { mean } from './stats.mts'
import {
  configForSelection,
  defaultSelection,
  neighboursOf,
  parameterOf,
  type Neighbour,
  type NeighbourMode,
  type Selection,
  type Space,
} from './space.mts'

export interface EvalJob {
  /** Interleave order: for each rep the configs run in this order. */
  configs: ResolvedConfig[]
  tasks: string[]
  reps: number
  label: string
}

/** Runs a job's pending trials and appends them to the ledger. */
export type Evaluator = (job: EvalJob) => Promise<void>

export interface ClimbOptions {
  space: Space
  store: LedgerStore
  evaluator: Evaluator
  screenReps: number
  confirmReps: number
  canaryReps: number
  neighbours: NeighbourMode
  only?: readonly string[]
  /** Fraction of candidates promoted from the screen (at least one, only those beating the incumbent). */
  promoteFraction: number
  /** Stop before a job that would exceed this many new trials in total. */
  maxTrials: number | null
  /** Stop before the next job once this much wall-clock time has passed. */
  maxMs: number | null
  maxRounds: number
  analysis: Partial<AnalysisOptions>
  /** A canary task whose pass rate drops by at least this much rejects the candidate. */
  canaryMaxDrop: number
  /** Re-run an underpowered but positive confirm once with double the reps. */
  escalate: boolean
  /** Attempts per cell that `pendingTrials` should assume (matches the evaluator's). */
  maxAttempts: number
  now: () => number
  log: (line: string) => void
}

export type DecisionOutcome =
  | 'accepted'
  | 'screen-negative'
  | 'not-promoted'
  | 'rejected-verdict'
  | 'rejected-canary'
  | 'skipped-budget'

export interface CanaryRow {
  task: string
  candidate: number | null
  incumbent: number | null
  status: 'ok' | 'regressed' | 'missing'
}

export interface CanaryResult {
  ok: boolean
  rows: CanaryRow[]
}

export interface ClimbDecision {
  round: number
  parameter: string
  from: string
  to: string
  candidate: { id: string; hash: string }
  incumbent: { id: string; hash: string }
  screen: { diff: number; tasks: number } | null
  confirm: Comparison | null
  canary: CanaryResult | null
  escalated: boolean
  outcome: DecisionOutcome
}

export type StopReason = 'converged' | 'budget:trials' | 'budget:time' | 'max-rounds'

export interface ClimbResult {
  start: ResolvedConfig
  final: ResolvedConfig
  finalSelection: Selection
  decisions: ClimbDecision[]
  accepted: ClimbDecision[]
  stopReason: StopReason
  /** New trials this call asked the evaluator to run. */
  trialsLaunched: number
}

/** Point estimate of the pass-rate difference on the tasks both configs have data for. */
export function pointDifference(
  store: LedgerStore,
  candidateHash: string,
  baselineHash: string,
  tasks: readonly string[],
): { diff: number; tasks: number } {
  const records = store.read()
  const a = outcomesByTask(records, candidateHash, tasks)
  const b = outcomesByTask(records, baselineHash, tasks)
  const diffs: number[] = []
  for (const [task, values] of a) {
    const other = b.get(task)
    if (other !== undefined && other.length > 0 && values.length > 0) {
      diffs.push(mean(values) - mean(other))
    }
  }
  return { diff: diffs.length === 0 ? Number.NaN : mean(diffs), tasks: diffs.length }
}

/** A candidate that loses `maxDrop` of any canary task's pass rate, or lacks canary data, fails. */
export function canaryCheck(
  store: LedgerStore,
  candidateHash: string,
  incumbentHash: string,
  tasks: readonly string[],
  maxDrop: number,
): CanaryResult {
  const records = store.read()
  const candidate = outcomesByTask(records, candidateHash, tasks)
  const incumbent = outcomesByTask(records, incumbentHash, tasks)
  const rows: CanaryRow[] = tasks.map((task) => {
    const a = candidate.get(task) ?? []
    const b = incumbent.get(task) ?? []
    if (a.length === 0 || b.length === 0) {
      return {
        task,
        candidate: a.length === 0 ? null : mean(a),
        incumbent: b.length === 0 ? null : mean(b),
        status: 'missing',
      }
    }
    const regressed = mean(b) - mean(a) >= maxDrop
    return { task, candidate: mean(a), incumbent: mean(b), status: regressed ? 'regressed' : 'ok' }
  })
  return { ok: rows.every((row) => row.status === 'ok'), rows }
}

export function promotedCount(candidates: number, fraction: number): number {
  return Math.max(1, Math.ceil(candidates * fraction))
}

class BudgetStop extends Error {
  readonly reason: 'budget:trials' | 'budget:time'

  constructor(reason: 'budget:trials' | 'budget:time') {
    super(reason)
    this.reason = reason
  }
}

export async function climb(options: ClimbOptions): Promise<ClimbResult> {
  const { space, store } = options
  const startedAt = options.now()
  let launched = 0
  const run = async (job: EvalJob): Promise<void> => {
    const pending = pendingTrials(
      store.read(),
      job.configs,
      job.tasks,
      job.reps,
      options.maxAttempts,
    ).length
    if (pending === 0) return
    if (options.maxMs !== null && options.now() - startedAt >= options.maxMs) {
      throw new BudgetStop('budget:time')
    }
    if (options.maxTrials !== null && launched + pending > options.maxTrials) {
      throw new BudgetStop('budget:trials')
    }
    options.log(`job ${job.label}: ${String(pending)} new trial(s)`)
    const before = store.read().length
    await options.evaluator(job)
    launched += store.read().length - before
  }

  const decisions: ClimbDecision[] = []
  const start = configForSelection(space, defaultSelection(space))
  let selection = defaultSelection(space)
  let incumbent = start
  const visited = new Set([start.hash])
  let stopReason: StopReason = 'max-rounds'
  const tasks = space.taskSets

  try {
    for (let round = 1; round <= options.maxRounds; round += 1) {
      const candidates = neighboursOf(space, selection, options.neighbours, options.only)
        .map((neighbour) => ({ neighbour, config: configForSelection(space, neighbour.selection) }))
        .filter(({ config }) => !visited.has(config.hash))
      if (candidates.length === 0) {
        stopReason = 'converged'
        break
      }
      options.log(
        `round ${String(round)}: incumbent ${incumbent.id}, ${String(candidates.length)} candidate(s)`,
      )
      await run({
        configs: [incumbent, ...candidates.map(({ config }) => config)],
        tasks: tasks.screen,
        reps: options.screenReps,
        label: `round ${String(round)} screen`,
      })
      const screened = candidates
        .map((candidate, order) => ({
          ...candidate,
          order,
          screen: pointDifference(store, candidate.config.hash, incumbent.hash, tasks.screen),
        }))
        .sort((a, b) => {
          const left = Number.isNaN(a.screen.diff) ? -Infinity : a.screen.diff
          const right = Number.isNaN(b.screen.diff) ? -Infinity : b.screen.diff
          return right - left || a.order - b.order
        })
      const slots = promotedCount(candidates.length, options.promoteFraction)
      const promoted = screened.filter((entry) => entry.screen.diff > 0).slice(0, slots)
      const promotedHashes = new Set(promoted.map((entry) => entry.config.hash))
      const record = (
        entry: (typeof screened)[number],
        outcome: DecisionOutcome,
        extra: Partial<ClimbDecision> = {},
      ): ClimbDecision => {
        const decision: ClimbDecision = {
          round,
          parameter: entry.neighbour.parameter,
          from: entry.neighbour.from,
          to: entry.neighbour.to,
          candidate: { id: entry.config.id, hash: entry.config.hash },
          incumbent: { id: incumbent.id, hash: incumbent.hash },
          screen: entry.screen,
          confirm: null,
          canary: null,
          escalated: false,
          outcome,
          ...extra,
        }
        decisions.push(decision)
        return decision
      }
      for (const entry of screened) {
        if (promotedHashes.has(entry.config.hash)) continue
        record(entry, entry.screen.diff > 0 ? 'not-promoted' : 'screen-negative')
      }

      let acceptedEntry: (typeof screened)[number] | null = null
      for (const entry of promoted) {
        const pair = [incumbent, entry.config]
        try {
          await run({
            configs: pair,
            tasks: tasks.confirm,
            reps: options.confirmReps,
            label: `round ${String(round)} confirm ${entry.config.id}`,
          })
          await run({
            configs: pair,
            tasks: tasks.canary,
            reps: options.canaryReps,
            label: `round ${String(round)} canary ${entry.config.id}`,
          })
          let confirm = compareConfigs(store.read(), entry.config.hash, incumbent.hash, {
            ...options.analysis,
            tasks: tasks.confirm,
          })
          let escalated = false
          if (options.escalate && confirm.verdict === 'underpowered' && confirm.diff > 0) {
            await run({
              configs: pair,
              tasks: tasks.confirm,
              reps: options.confirmReps * 2,
              label: `round ${String(round)} escalate ${entry.config.id}`,
            })
            escalated = true
            confirm = compareConfigs(store.read(), entry.config.hash, incumbent.hash, {
              ...options.analysis,
              tasks: tasks.confirm,
            })
          }
          const canary = canaryCheck(
            store,
            entry.config.hash,
            incumbent.hash,
            tasks.canary,
            options.canaryMaxDrop,
          )
          const better = confirm.verdict === 'better beyond noise'
          const outcome: DecisionOutcome = !better
            ? 'rejected-verdict'
            : canary.ok
              ? 'accepted'
              : 'rejected-canary'
          record(entry, outcome, { confirm, canary, escalated })
          options.log(
            `  ${entry.neighbour.parameter} ${entry.neighbour.from} -> ${entry.neighbour.to}: ${confirm.verdict}, canary ${canary.ok ? 'ok' : 'FAILED'} => ${outcome}`,
          )
          if (outcome === 'accepted') {
            acceptedEntry = entry
            break
          }
        } catch (error) {
          if (error instanceof BudgetStop) {
            record(entry, 'skipped-budget')
          }
          throw error
        }
      }
      if (acceptedEntry === null) {
        stopReason = 'converged'
        break
      }
      selection = acceptedEntry.neighbour.selection
      incumbent = acceptedEntry.config
      visited.add(incumbent.hash)
    }
  } catch (error) {
    if (!(error instanceof BudgetStop)) throw error
    stopReason = error.reason
  }
  return {
    start,
    final: incumbent,
    finalSelection: selection,
    decisions,
    accepted: decisions.filter((decision) => decision.outcome === 'accepted'),
    stopReason,
    trialsLaunched: launched,
  }
}

export interface PlanLine {
  label: string
  trials: number
}

export interface ClimbPlan {
  candidates: Neighbour[]
  promotedWorstCase: number
  lines: PlanLine[]
  /** Trials for round 1 with no escalation. */
  trials: number
  /** Round 1 if every promoted candidate also escalates. */
  worstCaseTrials: number
  minutes: number
  worstCaseMinutes: number
}

/**
 * The first round's schedule and trial count, resume-aware (cells already in the ledger
 * cost nothing). Later rounds exist only if a change is accepted, and each has the same
 * shape; their size cannot be known in advance, so the budget caps them.
 */
export function planClimb(options: ClimbOptions): ClimbPlan {
  const { space, store } = options
  const selection = defaultSelection(space)
  const incumbent = configForSelection(space, selection)
  const candidates = neighboursOf(space, selection, options.neighbours, options.only)
  const configs = candidates.map((neighbour) => configForSelection(space, neighbour.selection))
  const records = store.read()
  const pending = (cs: ResolvedConfig[], tasks: string[], reps: number): number =>
    pendingTrials(records, cs, tasks, reps, options.maxAttempts).length
  const slots = Math.min(
    candidates.length,
    promotedCount(candidates.length, options.promoteFraction),
  )
  const lines: PlanLine[] = [
    {
      label: `screen: incumbent + ${String(configs.length)} candidate(s) x ${String(space.taskSets.screen.length)} tasks x ${String(options.screenReps)} reps`,
      trials: pending([incumbent, ...configs], space.taskSets.screen, options.screenReps),
    },
  ]
  // Worst case: the first `slots` candidates are promoted; count their cells plus the incumbent's once.
  const promoted = configs.slice(0, slots)
  lines.push({
    label: `confirm: incumbent + up to ${String(slots)} promoted x ${String(space.taskSets.confirm.length)} tasks x ${String(options.confirmReps)} reps`,
    trials: pending([incumbent, ...promoted], space.taskSets.confirm, options.confirmReps),
  })
  lines.push({
    label: `canary: incumbent + up to ${String(slots)} promoted x ${String(space.taskSets.canary.length)} tasks x ${String(options.canaryReps)} reps`,
    trials: pending([incumbent, ...promoted], space.taskSets.canary, options.canaryReps),
  })
  const trials = lines.reduce((sum, line) => sum + line.trials, 0)
  const escalation = options.escalate
    ? pending([incumbent, ...promoted], space.taskSets.confirm, options.confirmReps * 2) -
      pending([incumbent, ...promoted], space.taskSets.confirm, options.confirmReps)
    : 0
  const rate = space.estimate.minutesPerTrial
  return {
    candidates,
    promotedWorstCase: slots,
    lines,
    trials,
    worstCaseTrials: trials + escalation,
    minutes: trials * rate,
    worstCaseMinutes: (trials + escalation) * rate,
  }
}

export function formatPlan(plan: ClimbPlan, options: ClimbOptions): string {
  const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`
  const rate = options.space.estimate.minutesPerTrial
  const lines = [
    `Hill-climb plan (${options.neighbours} neighbours, promote ${String(options.promoteFraction)} of candidates)`,
    '',
    `Round 1 candidates (${String(plan.candidates.length)}):`,
    ...plan.candidates.map(
      (candidate) => `  - ${candidate.parameter}: ${candidate.from} -> ${candidate.to}`,
    ),
    '',
    'Round 1 schedule (worst case: the candidates promoted from the screen are the first listed):',
    ...plan.lines.map((line) => `  - ${line.label}: ${String(line.trials)} trials`),
    '',
    `Round 1 total: ${String(plan.trials)} trials, about ${hours(plan.minutes)} at ${String(rate)} min/trial (${String(rate * 2)} min per two-task job)`,
    ...(options.escalate
      ? [
          `With every promoted candidate escalated once (double confirm reps): ${String(plan.worstCaseTrials)} trials, about ${hours(plan.worstCaseMinutes)}`,
        ]
      : []),
    '',
    "Each accepted change starts another round of the same shape; the incumbent's cells already in the",
    'ledger are reused, so later rounds cost less. The climb stops at the first round with no acceptance,',
    `after ${String(options.maxRounds)} rounds, or at the budget (${
      options.maxTrials === null ? 'no trial cap' : `${String(options.maxTrials)} trials`
    }, ${options.maxMs === null ? 'no time cap' : `${(options.maxMs / 3_600_000).toFixed(1)} h`}).`,
  ]
  return lines.join('\n')
}

function describeCanary(canary: CanaryResult): string {
  return canary.rows
    .map(
      (row) =>
        `| ${row.task} | ${row.candidate === null ? '-' : row.candidate.toFixed(2)} | ${row.incumbent === null ? '-' : row.incumbent.toFixed(2)} | ${row.status} |`,
    )
    .join('\n')
}

/** `report.md`: each accepted change with its evidence, and the PR checklist. */
export function renderReport(result: ClimbResult, options: ClimbOptions): string {
  const names = new Map<string, string>()
  for (const decision of result.decisions) {
    names.set(decision.candidate.hash, decision.candidate.id)
    names.set(decision.incumbent.hash, decision.incumbent.id)
  }
  names.set(result.start.hash, result.start.id)
  const lines = [
    '# Tuning hill-climb report',
    '',
    `- stopped: ${result.stopReason}`,
    `- decisions: ${String(result.decisions.length)}; accepted changes: ${String(result.accepted.length)}`,
    `- new trials launched by the last run: ${String(result.trialsLaunched)}`,
    `- starting config: ${result.start.id} (${result.start.hash.slice(0, 12)})`,
    `- final config: ${result.final.id} (${result.final.hash.slice(0, 12)})`,
    '',
    'This is measurement, not a change: nothing here modifies a product default. See',
    'benchmarks/terminal_bench/TUNING.md for how a winning value becomes a product PR.',
    '',
    '## Accepted changes',
    '',
  ]
  if (result.accepted.length === 0)
    lines.push('None. The defaults stand; no candidate beat them beyond noise.', '')
  result.accepted.forEach((decision, index) => {
    lines.push(
      `### ${String(index + 1)}. ${decision.parameter}: ${decision.from} -> ${decision.to} (round ${String(decision.round)})`,
      '',
    )
    if (decision.confirm !== null) lines.push(formatComparison(decision.confirm, names), '')
    if (decision.canary !== null) {
      lines.push(
        'Canary (pass rate, candidate vs incumbent):',
        '',
        '| task | candidate | incumbent | status |',
        '| --- | --- | --- | --- |',
        describeCanary(decision.canary),
        '',
      )
    }
    if (decision.screen !== null) {
      lines.push(
        `Screen (selection only, not evidence): difference ${decision.screen.diff.toFixed(2)} over ${String(decision.screen.tasks)} tasks.`,
        '',
      )
    }
  })
  lines.push(
    '## Other candidates',
    '',
    '| round | change | outcome | confirm verdict |',
    '| --- | --- | --- | --- |',
  )
  for (const decision of result.decisions.filter((entry) => entry.outcome !== 'accepted')) {
    lines.push(
      `| ${String(decision.round)} | ${decision.parameter}: ${decision.from} -> ${decision.to} | ${decision.outcome} | ${decision.confirm?.verdict ?? '-'} |`,
    )
  }
  lines.push('', '## Proposed product-default changes: PR checklist', '')
  if (result.accepted.length === 0) lines.push('- [ ] Nothing to propose.')
  for (const decision of result.accepted) {
    const parameter = parameterOf(options.space, decision.parameter)
    const value = parameter.values.find((candidate) => candidate.label === decision.to)
    const seam = parameter.productSeam
    lines.push(
      seam === null
        ? `- [ ] ${decision.parameter} = ${decision.to}: this knob has no product seam yet; add one before it can become a default`
        : `- [ ] Change \`${seam.symbol}\` (${seam.file}) to match ${decision.parameter} = ${decision.to} (tuning \`${JSON.stringify(value?.set ?? {})}\`)`,
    )
  }
  if (result.accepted.length > 0) {
    lines.push(
      '- [ ] Open that change as its own PR, separate from this tool, and paste the evidence tables above',
      `- [ ] Cite config hashes ${result.accepted.map((d) => d.candidate.hash.slice(0, 12)).join(', ')} and the ledger lines`,
      '- [ ] Re-run the final config against the starting config on a different task set before merging',
      '- [ ] Confirm the canary tasks still pass with the new default in the product loop (not only the benchmark entry)',
      '- [ ] Update any test or doc that pins the old default',
    )
  }
  lines.push('')
  return lines.join('\n')
}
