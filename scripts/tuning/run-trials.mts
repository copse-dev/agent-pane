/**
 * Run (config, task, rep) trials through Harbor with the container agent and append
 * one line per trial to the ledger. Resumable: cells already in the ledger are skipped.
 *
 *   node scripts/tuning/run-trials.mts --config default --tasks fix-git,regex-log --reps 3 \
 *     [--interleave hc-1234abcd] [--batch 2] [--dry-run]
 *
 * Benchmark-only (see benchmarks/terminal_bench/TUNING.md). Never changes a product default.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shellDisplay } from '../lib/terminal-bench.mts'
import { terminalBenchRequestedTaskNames } from '../lib/terminal-bench.mts'
import { ConfigRegistry, resolveConfigArgument, type ResolvedConfig } from './configs.mts'
import {
  DEFAULT_LEDGER_PATH,
  FileLedger,
  infrastructureEvidence,
  invalidReasons,
  pendingTrials,
  type LedgerStore,
  type TrialRecord,
  type TrialRequest,
} from './ledger.mts'
import {
  buildHarborLaunch,
  loadedLmStudioModels,
  observeJob,
  tuningWasApplied,
  type HarborLaunch,
  type TrialObservation,
} from './harbor-run.mts'
import { configForSelection, defaultSelection, loadSpace } from './space.mts'

export const DEFAULT_JOBS_DIR = 'bench-results/tuning/jobs'
export const DEFAULT_REGISTRY_DIR = 'bench-results/tuning/configs'
export const DEFAULT_SPACE_PATH = 'scripts/tuning/space.json'

export interface RunnerDeps {
  /** Run the launch to completion, logging its output to `logPath`; resolves with the exit code. */
  execute(launch: HarborLaunch, logPath: string): Promise<number>
  /** What a finished job directory holds, by canonical task name. */
  observeJob(jobDir: string): Map<string, TrialObservation>
  loadedModels(): Promise<string[] | null>
  codeRevision(): string | null
  now(): Date
  log(line: string): void
}

export interface RunTrialsOptions {
  /** Interleave order: for each rep, configs run in this order. */
  configs: readonly ResolvedConfig[]
  tasks: readonly string[]
  reps: number
  /** Tasks per Harbor job. */
  batchSize: number
  maxAttempts: number
  model: string
  jobsDir: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  dryRun: boolean
  store: LedgerStore
  registry: ConfigRegistry | null
}

export interface RunTrialsResult {
  /** Trials recorded in the ledger by this call. */
  recorded: number
  /** Cells that were already done. */
  skipped: number
  jobs: HarborLaunch[]
}

export interface Batch {
  config: ResolvedConfig
  rep: number
  tasks: string[]
}

/** The jobs still to run, interleaved by rep then config, each at most `batchSize` tasks. */
export function planBatches(
  pending: readonly TrialRequest[],
  configs: readonly ResolvedConfig[],
  batchSize: number,
): Batch[] {
  const reps = [...new Set(pending.map((request) => request.rep))].sort((a, b) => a - b)
  const batches: Batch[] = []
  for (const rep of reps) {
    for (const config of configs) {
      const tasks = pending
        .filter((request) => request.rep === rep && request.config.hash === config.hash)
        .map((request) => request.task)
      for (let start = 0; start < tasks.length; start += batchSize) {
        batches.push({ config, rep, tasks: tasks.slice(start, start + batchSize) })
      }
    }
  }
  return batches
}

export function jobName(config: ResolvedConfig, rep: number, at: Date): string {
  return `tune-${config.id}-r${String(rep)}-${at.getTime().toString(36)}`
}

/** A ledger line from what a trial left behind (or from nothing, if it left nothing). */
export function buildTrialRecord(input: {
  config: ResolvedConfig
  task: string
  rep: number
  observation: TrialObservation | null
  jobDir: string
  lmStudioModels: string[] | null
  codeRevision: string | null
  startedAt: string
  finishedAt: string
}): TrialRecord {
  const { observation, config } = input
  const exceptionType = observation?.exception?.type ?? null
  const reasons = invalidReasons({
    resultFound: observation !== null,
    reward: observation?.reward ?? null,
    exceptionType,
    logEvidence: infrastructureEvidence(observation?.logTexts ?? []),
    tuningNotApplied: observation !== null && !tuningWasApplied(observation, config.tuning),
  })
  return {
    schemaVersion: 1,
    config: { id: config.id, hash: config.hash },
    tuning: config.tuning,
    task: input.task,
    rep: input.rep,
    reward: observation?.reward ?? null,
    agentSeconds: observation?.agentSeconds ?? null,
    modelCalls: observation?.modelCalls ?? null,
    inputTokens: observation?.inputTokens ?? null,
    outputTokens: observation?.outputTokens ?? null,
    stopReason: observation?.stopReason ?? null,
    exception: observation?.exception ?? null,
    denials: observation?.denials ?? null,
    deferrals: observation?.deferrals ?? null,
    promptsAttempted: observation?.promptsAttempted ?? null,
    lmStudioModels: input.lmStudioModels,
    codeRevision: input.codeRevision,
    startedAt: observation?.startedAt ?? input.startedAt,
    finishedAt: observation?.finishedAt ?? input.finishedAt,
    jobDir: input.jobDir,
    trialDir: observation?.trialDir ?? null,
    valid: reasons.length === 0,
    invalidReasons: reasons,
  }
}

export async function runTrials(
  options: RunTrialsOptions,
  deps: RunnerDeps,
): Promise<RunTrialsResult> {
  const total = options.configs.length * options.tasks.length * options.reps
  const pending = pendingTrials(
    options.store.read(),
    options.configs,
    options.tasks,
    options.reps,
    options.maxAttempts,
  )
  const result: RunTrialsResult = { recorded: 0, skipped: total - pending.length, jobs: [] }
  deps.log(
    `tuning: ${String(pending.length)} trial(s) to run, ${String(result.skipped)} already in the ledger`,
  )
  const batches = planBatches(pending, options.configs, options.batchSize)
  const jobsDir = resolve(options.jobsDir)
  for (const batch of batches) {
    const name = jobName(batch.config, batch.rep, deps.now())
    const launch = buildHarborLaunch({
      model: options.model,
      tasks: batch.tasks,
      jobName: name,
      jobsDir,
      tuning: batch.config.tuning,
      repoRoot: options.repoRoot,
      env: options.env,
    })
    result.jobs.push(launch)
    if (options.dryRun) {
      deps.log(`job ${name} (config ${batch.config.id}, rep ${String(batch.rep)})`)
      deps.log(
        `  env: ${Object.entries(launch.setEnv)
          .map(([key, value]) => `${key}='${value.replaceAll("'", `'\\''`)}'`)
          .join(' ')}`,
      )
      deps.log(`  ${shellDisplay(launch.command, launch.args)}`)
      continue
    }
    options.registry?.register(batch.config)
    const startedAt = deps.now().toISOString()
    const models = await deps.loadedModels()
    mkdirSync(jobsDir, { recursive: true })
    const exitCode = await deps.execute(launch, resolve(jobsDir, `${name}.log`))
    deps.log(`job ${name} exited ${String(exitCode)}`)
    const jobDir = resolve(jobsDir, name)
    const observations = deps.observeJob(jobDir)
    const finishedAt = deps.now().toISOString()
    for (const task of batch.tasks) {
      const record = buildTrialRecord({
        config: batch.config,
        task,
        rep: batch.rep,
        observation: observations.get(task) ?? null,
        jobDir,
        lmStudioModels: models,
        codeRevision: deps.codeRevision(),
        startedAt,
        finishedAt,
      })
      options.store.append(record)
      result.recorded += 1
      deps.log(
        `  ${task} rep ${String(batch.rep)} config ${batch.config.id}: reward=${String(record.reward)}` +
          (record.valid ? '' : ` INVALID (${record.invalidReasons.join(', ')})`),
      )
    }
  }
  return result
}

/** Comma-separated task names, or `@file` with one name per line (`#` comments allowed). */
export function parseTaskArgument(argument: string, readFile: (path: string) => string): string[] {
  const text = argument.startsWith('@')
    ? readFile(argument.slice(1))
        .split('\n')
        .map((line) => line.replace(/#.*/, '').trim())
        .filter((line) => line !== '')
        .join(',')
    : argument
  return terminalBenchRequestedTaskNames(text) ?? []
}

function codeRevision(): string | null {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status !== 0) return null
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  return `${head.stdout.trim()}${dirty.stdout.trim() === '' ? '' : '+dirty'}`
}

export function realDeps(lmStudioUrl: string): RunnerDeps {
  return {
    execute: (launch, logPath) =>
      new Promise((resolveExit) => {
        const fd = openSync(logPath, 'a')
        const child = spawn(launch.command, launch.args, {
          env: launch.env,
          stdio: ['ignore', fd, fd],
        })
        child.once('error', () => {
          closeSync(fd)
          resolveExit(1)
        })
        child.once('close', (code) => {
          closeSync(fd)
          resolveExit(code ?? 1)
        })
      }),
    observeJob,
    loadedModels: () => loadedLmStudioModels(lmStudioUrl),
    codeRevision,
    now: (): Date => new Date(),
    log: (line): void => {
      console.log(line)
    },
  }
}

interface CliFlags {
  values: Map<string, string[]>
  switches: Set<string>
}

const VALUE_FLAGS = [
  'config',
  'tasks',
  'reps',
  'interleave',
  'batch',
  'max-attempts',
  'model',
  'jobs-dir',
  'ledger',
  'space',
  'lm-studio-url',
]
const SWITCH_FLAGS = ['dry-run', 'no-build', 'retry-invalid']

function parseFlags(argv: readonly string[]): CliFlags {
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const name = arg.replace(/^--/, '')
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}'`)
    if (SWITCH_FLAGS.includes(name)) switches.add(name)
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      values.set(name, [...(values.get(name) ?? []), value])
      index += 1
    } else throw new Error(`Unknown flag '${arg}'`)
  }
  return { values, switches }
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`)
  return value
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const one = (name: string): string | undefined => flags.values.get(name)?.at(-1)
  const need = (name: string): string => {
    const value = one(name)
    if (value === undefined) throw new Error(`--${name} is required`)
    return value
  }
  const dryRun = flags.switches.has('dry-run')
  const space = loadSpace(one('space') ?? DEFAULT_SPACE_PATH)
  const registry = new ConfigRegistry(DEFAULT_REGISTRY_DIR)
  const context = {
    defaultConfig: configForSelection(space, defaultSelection(space)),
    registry,
  }
  const configs: ResolvedConfig[] = []
  for (const argument of [
    need('config'),
    ...(flags.values.get('interleave') ?? []).flatMap((value) => value.split(',')),
  ]) {
    const config = resolveConfigArgument(argument, context)
    if (!configs.some((existing) => existing.hash === config.hash)) configs.push(config)
  }
  const tasks = parseTaskArgument(need('tasks'), (path) => readFileSync(path, 'utf8'))
  const model =
    one('model') ?? process.env['LM_STUDIO_MODEL']?.trim() ?? (dryRun ? '<LM_STUDIO_MODEL>' : '')
  if (model === '')
    throw new Error('Pass --model or set LM_STUDIO_MODEL to the model LM Studio loaded.')
  const lmStudioUrl =
    one('lm-studio-url') ?? process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1'
  if (!dryRun) {
    const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
    })
    if (docker.status !== 0) throw new Error('Docker is unavailable')
    if (!flags.switches.has('no-build')) {
      const { buildHarborContainer } = await import('../build-harbor-container.mts')
      console.log(`tuning: harbor payload=${(await buildHarborContainer()).outDir}`)
    }
  }
  const result = await runTrials(
    {
      configs,
      tasks,
      reps: positiveInteger(need('reps'), 'reps'),
      batchSize: positiveInteger(one('batch') ?? '2', 'batch'),
      maxAttempts: flags.switches.has('retry-invalid')
        ? 2
        : positiveInteger(one('max-attempts') ?? '1', 'max-attempts'),
      model,
      jobsDir: one('jobs-dir') ?? DEFAULT_JOBS_DIR,
      repoRoot: resolve(),
      env: process.env,
      dryRun,
      store: new FileLedger(one('ledger') ?? DEFAULT_LEDGER_PATH),
      registry: dryRun ? null : registry,
    },
    realDeps(lmStudioUrl),
  )
  console.log(
    `tuning: ${dryRun ? 'dry run, ' : ''}${String(result.recorded)} recorded, ${String(result.skipped)} skipped, ${String(result.jobs.length)} job(s)`,
  )
}

if (process.argv[1]?.endsWith('run-trials.mts')) {
  void main().catch((error: unknown) => {
    console.error(`tuning:run-trials: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
