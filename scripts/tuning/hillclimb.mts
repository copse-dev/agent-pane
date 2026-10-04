/**
 * Hill-climb the declared parameter space with the Harbor container agent as the
 * measurement.
 *
 *   node scripts/tuning/hillclimb.mts --plan              # print the schedule and cost; launch nothing
 *   node scripts/tuning/hillclimb.mts --max-hours 12      # climb, resumably, within a budget
 *
 * Writes `bench-results/tuning/report.md` (accepted changes, evidence, PR checklist) and
 * `climb-journal.json`. Benchmark-only: it never changes a product default.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { terminalBenchRequestedTaskNames } from '../lib/terminal-bench.mts'
import { DEFAULT_ANALYSIS_OPTIONS } from './analysis.mts'
import { ConfigRegistry } from './configs.mts'
import {
  climb,
  formatPlan,
  planClimb,
  renderReport,
  type ClimbOptions,
  type Evaluator,
} from './hillclimb-lib.mts'
import { DEFAULT_LEDGER_PATH, FileLedger, type LedgerStore } from './ledger.mts'
import {
  DEFAULT_JOBS_DIR,
  DEFAULT_REGISTRY_DIR,
  DEFAULT_SPACE_PATH,
  realDeps,
  runTrials,
} from './run-trials.mts'
import { loadSpace, type NeighbourMode } from './space.mts'

export const DEFAULT_REPORT_PATH = 'bench-results/tuning/report.md'
export const DEFAULT_JOURNAL_PATH = 'bench-results/tuning/climb-journal.json'

const VALUE_FLAGS = [
  'space',
  'ledger',
  'report',
  'journal',
  'screen-reps',
  'confirm-reps',
  'canary-reps',
  'neighbours',
  'params',
  'promote',
  'max-trials',
  'max-hours',
  'max-rounds',
  'canary-max-drop',
  'min-effect',
  'seed',
  'model',
  'lm-studio-url',
]
const SWITCH_FLAGS = ['plan', 'no-escalate', 'no-build']

function parseFlags(argv: readonly string[]): {
  values: Map<string, string>
  switches: Set<string>
} {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const name = arg.replace(/^--/, '')
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}'`)
    if (SWITCH_FLAGS.includes(name)) switches.add(name)
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      values.set(name, value)
      index += 1
    } else throw new Error(`Unknown flag '${arg}'`)
  }
  return { values, switches }
}

function numberFlag(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  integer: boolean,
): number {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be a positive ${integer ? 'integer' : 'number'}`)
  }
  return value
}

/** The real evaluator: Harbor jobs through `runTrials`, retrying an invalid trial once. */
function harborEvaluator(store: LedgerStore, model: string, lmStudioUrl: string): Evaluator {
  const registry = new ConfigRegistry(DEFAULT_REGISTRY_DIR)
  return async (job) => {
    await runTrials(
      {
        configs: job.configs,
        tasks: job.tasks,
        reps: job.reps,
        batchSize: 2,
        maxAttempts: 2,
        model,
        jobsDir: DEFAULT_JOBS_DIR,
        repoRoot: resolve(),
        env: process.env,
        dryRun: false,
        store,
        registry,
      },
      realDeps(lmStudioUrl),
    )
  }
}

async function main(): Promise<void> {
  const { values, switches } = parseFlags(process.argv.slice(2))
  const space = loadSpace(values.get('space') ?? DEFAULT_SPACE_PATH)
  terminalBenchRequestedTaskNames(
    [...space.taskSets.screen, ...space.taskSets.confirm, ...space.taskSets.canary].join(','),
  )
  const neighbours = values.get('neighbours') ?? 'adjacent'
  if (neighbours !== 'adjacent' && neighbours !== 'all') {
    throw new Error("--neighbours must be 'adjacent' or 'all'")
  }
  const mode: NeighbourMode = neighbours
  const only = values
    .get('params')
    ?.split(',')
    .filter((id) => id !== '')
  const store = new FileLedger(values.get('ledger') ?? DEFAULT_LEDGER_PATH)
  const model = values.get('model') ?? process.env['LM_STUDIO_MODEL']?.trim() ?? ''
  const lmStudioUrl =
    values.get('lm-studio-url') ?? process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1'
  const started = Date.now()
  const options: ClimbOptions = {
    space,
    store,
    evaluator: () => Promise.reject(new Error('No evaluator is attached in --plan mode')),
    screenReps: numberFlag(values, 'screen-reps', 3, true),
    confirmReps: numberFlag(values, 'confirm-reps', 3, true),
    canaryReps: numberFlag(values, 'canary-reps', 2, true),
    neighbours: mode,
    ...(only === undefined ? {} : { only }),
    promoteFraction: numberFlag(values, 'promote', 0.5, false),
    maxTrials: values.has('max-trials') ? numberFlag(values, 'max-trials', 1, true) : null,
    maxMs: values.has('max-hours') ? numberFlag(values, 'max-hours', 1, false) * 3_600_000 : null,
    maxRounds: numberFlag(values, 'max-rounds', 5, true),
    analysis: {
      seed: numberFlag(values, 'seed', DEFAULT_ANALYSIS_OPTIONS.seed, true),
      minEffect: numberFlag(values, 'min-effect', DEFAULT_ANALYSIS_OPTIONS.minEffect, false),
    },
    canaryMaxDrop: numberFlag(values, 'canary-max-drop', 0.5, false),
    escalate: !switches.has('no-escalate'),
    maxAttempts: 2,
    now: () => Date.now(),
    log: (line) => {
      console.log(line)
    },
  }
  if (switches.has('plan')) {
    console.log(formatPlan(planClimb(options), options))
    return
  }
  if (model === '')
    throw new Error('Pass --model or set LM_STUDIO_MODEL to the model LM Studio loaded.')
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  })
  if (docker.status !== 0) throw new Error('Docker is unavailable')
  if (!switches.has('no-build')) {
    const { buildHarborContainer } = await import('../build-harbor-container.mts')
    console.log(`tuning: harbor payload=${(await buildHarborContainer()).outDir}`)
  }
  const result = await climb({ ...options, evaluator: harborEvaluator(store, model, lmStudioUrl) })
  const reportPath = resolve(values.get('report') ?? DEFAULT_REPORT_PATH)
  const journalPath = resolve(values.get('journal') ?? DEFAULT_JOURNAL_PATH)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, renderReport(result, options))
  writeFileSync(journalPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    `tuning: ${result.stopReason}; ${String(result.accepted.length)} accepted; ${String(result.trialsLaunched)} trials launched in ${((Date.now() - started) / 60000).toFixed(1)} min; report ${reportPath}`,
  )
}

if (process.argv[1]?.endsWith('hillclimb.mts')) {
  void main().catch((error: unknown) => {
    console.error(`tuning:hillclimb: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
