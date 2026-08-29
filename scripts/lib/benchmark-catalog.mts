import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { foldMessage } from '../../src/shared/threads/fold.ts'
import { parseSpine } from '../../src/shared/threads/spine-schema.ts'

type JsonDecoder<T> = (value: unknown) => T | null

/**
 * Script-local equivalents of the shared safe JSON boundary. The shared file
 * is `.ts` under the root CommonJS package, so this directly executed ESM
 * `.mts` command cannot import its named exports.
 */
function decodeWithSchema<T>(schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}): JsonDecoder<T> {
  return (value) => {
    const result = schema.safeParse(value)
    return result.success ? result.data : null
  }
}

function safeJsonParse<T>(text: string, decoder: JsonDecoder<T>): T | null {
  try {
    const value: unknown = JSON.parse(text)
    return decoder(value)
  } catch {
    return null
  }
}

const optionalMetric = z.number().nullable().optional()
const skillsResultSchema = z.looseObject({
  n_tool_calls: optionalMetric,
  n_skill_invocations: optionalMetric,
  n_input_tokens: optionalMetric,
  n_output_tokens: optionalMetric,
  model: z.string().min(1).nullable().optional(),
  error: z.string().nullable().optional(),
  error_category: z.string().nullable().optional(),
  verifier_error: z.string().nullable().optional(),
  verifier_error_category: z.string().nullable().optional(),
  partial_trajectory: z.boolean().nullable().optional(),
})

const skillsManifestSchema = z.looseObject({
  schemaVersion: z.literal(1),
  benchmark: z.looseObject({ id: z.string().min(1), version: z.string().min(1) }),
  task: z.looseObject({ name: z.string().min(1) }),
  profile: z.looseObject({ id: z.string().min(1) }).optional(),
  mode: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
  sourceCommit: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  elapsedSeconds: optionalMetric,
  officialReward: optionalMetric,
  result: skillsResultSchema.optional(),
})

const terminalManifestSchema = z.looseObject({
  schemaVersion: z.literal(2),
  trialId: z.string().min(1),
  suiteRunId: z.string().min(1),
  createdAt: z.string().min(1),
  task: z.looseObject({
    name: z.string().min(1),
    attemptIndex: z.number().int().positive(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
    reward: optionalMetric,
    exception: z.unknown().nullable().optional(),
  }),
  model: z.string().min(1).nullable().optional(),
  dataset: z.looseObject({ id: z.string().min(1), version: z.string().min(1) }),
  profile: z.looseObject({
    id: z.string().min(1),
    versionedId: z.string().min(1),
  }),
  source: z.looseObject({ commit: z.string().min(1) }).optional(),
  metrics: z.looseObject({
    elapsedSeconds: optionalMetric,
    inputTokens: optionalMetric,
    outputTokens: optionalMetric,
    toolCalls: optionalMetric,
  }),
})

const benchmarkRunSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  benchmark: z.string(),
  benchmarkVersion: z.string(),
  createdAt: z.string(),
  models: z.array(z.string()),
  variants: z.array(z.string()),
  sourceCommits: z.array(z.string()),
  trialCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  flagged: z.number().int().nonnegative(),
  meanReward: z.number().nullable(),
  indexPath: z.string(),
})

const benchmarkCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  sources: z.array(z.string()),
  lowWorkFloor: z.object({
    minInputTokens: z.number().int().positive(),
    minToolCalls: z.number().int().positive(),
  }),
  runs: z.array(benchmarkRunSummarySchema),
  warnings: z.array(z.string()),
})

type SkillsManifest = z.infer<typeof skillsManifestSchema>
type TerminalManifest = z.infer<typeof terminalManifestSchema>

export interface LowWorkFloor {
  minInputTokens: number
  minToolCalls: number
}

export interface BenchmarkToolCall {
  id: string
  name: string
  args: unknown
  status: 'done' | 'error' | 'running'
  result: string | null
}

export interface TraceMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  reasoning?: string
  model?: string
  createdAt: number
  toolCalls: BenchmarkToolCall[]
}

export type BenchmarkFlag =
  'agent-error' | 'low-work' | 'missing-trace' | 'partial-trace' | 'verifier-error'

export type BenchmarkOutcome = 'error' | 'fail' | 'invalid' | 'pass' | 'timeout'

export interface BenchmarkTrial {
  id: string
  slug: string
  runId: string
  runSlug: string
  sourceRunId: string
  benchmark: string
  benchmarkVersion: string
  task: string
  variant: string
  attempt: number
  model: string
  sourceCommit: string | null
  startedAt: string | null
  reward: number | null
  passed: boolean
  outcome: BenchmarkOutcome
  elapsedSeconds: number | null
  inputTokens: number | null
  outputTokens: number | null
  toolCalls: number | null
  skillReads: number | null
  reasoningCharacters: number
  prompt: string
  trace: TraceMessage[]
  flags: BenchmarkFlag[]
  agentError: string | null
  agentErrorCategory: string | null
  verifierError: string | null
  verifierErrorCategory: string | null
}

export type BenchmarkTrialSummary = Omit<BenchmarkTrial, 'trace'> & {
  traceLength: number
  detailPath: string
}

export interface BenchmarkRunSummary {
  id: string
  slug: string
  benchmark: string
  benchmarkVersion: string
  createdAt: string
  models: string[]
  variants: string[]
  sourceCommits: string[]
  trialCount: number
  taskCount: number
  passed: number
  flagged: number
  meanReward: number | null
  indexPath: string
}

export interface BenchmarkCatalog {
  schemaVersion: 1
  generatedAt: string
  sources: string[]
  lowWorkFloor: LowWorkFloor
  runs: BenchmarkRunSummary[]
  warnings: string[]
}

export interface BenchmarkRunIndex {
  schemaVersion: 1
  run: BenchmarkRunSummary
  trials: BenchmarkTrialSummary[]
}

export interface BenchmarkData {
  catalog: BenchmarkCatalog
  runs: Array<{ summary: BenchmarkRunSummary; trials: BenchmarkTrial[] }>
}

export interface BuildBenchmarkDataOptions {
  artifactRoots: string[]
  lowWorkFloor?: LowWorkFloor
  generatedAt?: Date
}

export interface BuildBenchmarkSiteOptions extends BuildBenchmarkDataOptions {
  append?: boolean
  outputDir: string
}

export const DEFAULT_LOW_WORK_FLOOR: LowWorkFloor = {
  minInputTokens: 1_000,
  minToolCalls: 3,
}

const PASS_REWARD = 0.99
const VIEWER_ASSET_ROOT = resolve('benchmarks/benchmark-explorer')
const VIEWER_ASSETS = [
  { source: resolve(VIEWER_ASSET_ROOT, 'index.html'), output: 'index.html' },
  { source: resolve(VIEWER_ASSET_ROOT, 'styles.css'), output: 'styles.css' },
  { source: resolve(VIEWER_ASSET_ROOT, 'app.js'), output: 'app.js' },
  { source: resolve('assets/brand-mark.svg'), output: 'assets/brand-mark.svg' },
  { source: resolve('assets/fonts/Pliant-Variable.ttf'), output: 'assets/Pliant-Variable.ttf' },
  {
    source: resolve('assets/fonts/AveriaSerifLibre-Regular.ttf'),
    output: 'assets/AveriaSerifLibre-Regular.ttf',
  },
] as const

function normalizedRunId(runId: string): string {
  return runId.trim().replace(/-shard-\d+$/, '')
}

function finiteMetric(value: number | null | undefined): number | null {
  return value ?? null
}

function nonEmptyError(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeSlug(value: string, hashSource = value): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${base || 'run'}-${sha256(hashSource).slice(0, 10)}`
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function foldTrace(threadDir: string): TraceMessage[] {
  const eventsPath = resolve(threadDir, 'events.jsonl')
  const body = readFileSync(eventsPath, 'utf8')
  const resolveRef = (ref: string): string => {
    const target = resolve(threadDir, ref)
    if (!isInside(threadDir, target)) throw new Error(`trace ref escapes thread: ${ref}`)
    return readFileSync(target, 'utf8')
  }
  return parseSpine(body).map((line) => {
    const message = foldMessage(line, resolveRef, { hash: sha256 })
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      toolCalls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        status: toolCall.status,
        result: toolCall.result,
      })),
      ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
      ...(message.model !== undefined ? { model: message.model } : {}),
    }
  })
}

async function collectInputPaths(root: string): Promise<string[]> {
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (
        entry.isFile() &&
        (entry.name === 'manifest.json' || entry.name === 'run-manifest.json')
      ) {
        paths.push(path)
      }
    }
  }
  await visit(root)
  return paths.sort()
}

function trialIdentity(runId: string, root: string, manifestPath: string): string {
  const relativePath = relative(root, dirname(manifestPath)) || basename(dirname(manifestPath))
  return `${runId}/${basename(relativePath)}-${sha256(`${runId}:${relativePath}`).slice(0, 10)}`
}

function diagnosticFlags(
  inputTokens: number | null,
  toolCalls: number | null,
  trace: readonly TraceMessage[],
  floor: LowWorkFloor,
  options: { agentError?: boolean; partial?: boolean; verifierError?: boolean } = {},
): BenchmarkFlag[] {
  const flags: BenchmarkFlag[] = []
  if (
    inputTokens !== null &&
    toolCalls !== null &&
    inputTokens < floor.minInputTokens &&
    toolCalls < floor.minToolCalls
  ) {
    flags.push('low-work')
  }
  if (options.agentError) flags.push('agent-error')
  if (options.verifierError) flags.push('verifier-error')
  if (options.partial) flags.push('partial-trace')
  if (trace.length === 0) flags.push('missing-trace')
  return flags
}

function exceptionDetail(value: unknown): { category: string | null; message: string | null } {
  if (typeof value !== 'object' || value === null) return { category: null, message: null }
  const category: unknown = 'exception_type' in value ? value.exception_type : undefined
  const message: unknown = 'message' in value ? value.message : undefined
  return {
    category: typeof category === 'string' && category ? category : null,
    message: typeof message === 'string' && message ? message : null,
  }
}

function skillsTrial(
  manifest: SkillsManifest,
  manifestPath: string,
  root: string,
  trace: TraceMessage[],
  floor: LowWorkFloor,
): BenchmarkTrial {
  const sourceRunId = manifest.runId ?? basename(root)
  const runId = normalizedRunId(sourceRunId)
  const runKey = `${manifest.benchmark.id}:${manifest.benchmark.version}:${runId}`
  const runSlug = safeSlug(runId, runKey)
  const result = manifest.result
  const reward = finiteMetric(manifest.officialReward)
  const agentError = nonEmptyError(result?.error)
  const verifierError = nonEmptyError(result?.verifier_error)
  const id = trialIdentity(runId, root, manifestPath)
  const passed = reward !== null && reward >= PASS_REWARD
  return {
    id,
    slug: safeSlug(basename(dirname(manifestPath)), id),
    runId,
    runSlug,
    sourceRunId,
    benchmark: manifest.benchmark.id,
    benchmarkVersion: manifest.benchmark.version,
    task: manifest.task.name,
    variant: manifest.profile?.id ?? manifest.mode ?? 'unknown',
    attempt: manifest.attempt ?? 1,
    model: manifest.model ?? result?.model ?? 'unknown',
    sourceCommit: manifest.sourceCommit ?? null,
    startedAt: manifest.createdAt ?? null,
    reward,
    passed,
    outcome: agentError || verifierError ? 'error' : passed ? 'pass' : 'fail',
    elapsedSeconds: finiteMetric(manifest.elapsedSeconds),
    inputTokens: finiteMetric(result?.n_input_tokens),
    outputTokens: finiteMetric(result?.n_output_tokens),
    toolCalls: finiteMetric(result?.n_tool_calls),
    skillReads: finiteMetric(result?.n_skill_invocations),
    reasoningCharacters: trace.reduce(
      (total, message) => total + (message.reasoning?.length ?? 0),
      0,
    ),
    prompt: trace.find((message) => message.role === 'user')?.content ?? '',
    trace,
    flags: diagnosticFlags(
      finiteMetric(result?.n_input_tokens),
      finiteMetric(result?.n_tool_calls),
      trace,
      floor,
      {
        agentError: agentError !== null,
        verifierError: verifierError !== null,
        partial: result?.partial_trajectory === true,
      },
    ),
    agentError,
    agentErrorCategory: nonEmptyError(result?.error_category),
    verifierError,
    verifierErrorCategory: nonEmptyError(result?.verifier_error_category),
  }
}

function terminalOutcome(reward: number | null, category: string | null): BenchmarkOutcome {
  if (reward !== null && reward >= PASS_REWARD) return 'pass'
  if (category === 'AgentTimeoutError') return 'timeout'
  if (category) return 'invalid'
  return 'fail'
}

function terminalTrial(
  manifest: TerminalManifest,
  trace: TraceMessage[],
  floor: LowWorkFloor,
): BenchmarkTrial {
  const runId = manifest.suiteRunId
  const runKey = `${manifest.dataset.id}:${manifest.dataset.version}:${runId}`
  const runSlug = safeSlug(runId, runKey)
  const reward = finiteMetric(manifest.task.reward)
  const exception = exceptionDetail(manifest.task.exception)
  const outcome = terminalOutcome(reward, exception.category)
  const inputTokens = finiteMetric(manifest.metrics.inputTokens)
  const toolCalls = finiteMetric(manifest.metrics.toolCalls)
  return {
    id: manifest.trialId,
    slug: safeSlug(manifest.trialId),
    runId,
    runSlug,
    sourceRunId: runId,
    benchmark: manifest.dataset.id,
    benchmarkVersion: manifest.dataset.version,
    task: manifest.task.name,
    variant: manifest.profile.versionedId,
    attempt: manifest.task.attemptIndex,
    model: manifest.model ?? 'unknown',
    sourceCommit: manifest.source?.commit ?? null,
    startedAt: manifest.task.startedAt ?? manifest.createdAt,
    reward,
    passed: outcome === 'pass',
    outcome,
    elapsedSeconds: finiteMetric(manifest.metrics.elapsedSeconds),
    inputTokens,
    outputTokens: finiteMetric(manifest.metrics.outputTokens),
    toolCalls,
    skillReads: null,
    reasoningCharacters: trace.reduce(
      (total, message) => total + (message.reasoning?.length ?? 0),
      0,
    ),
    prompt: trace.find((message) => message.role === 'user')?.content ?? '',
    trace,
    flags: diagnosticFlags(inputTokens, toolCalls, trace, floor, {
      agentError: exception.message !== null,
    }),
    agentError: exception.message,
    agentErrorCategory: exception.category,
    verifierError: null,
    verifierErrorCategory: null,
  }
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort()
}

function summarizeRun(trials: BenchmarkTrial[], generatedAt: string): BenchmarkRunSummary {
  const first = trials[0]
  if (!first) throw new Error('cannot summarize an empty benchmark run')
  const rewards = trials.flatMap((trial) => (trial.reward === null ? [] : [trial.reward]))
  const timestamps = unique(trials.map((trial) => trial.startedAt))
  return {
    id: first.runId,
    slug: first.runSlug,
    benchmark: first.benchmark,
    benchmarkVersion: first.benchmarkVersion,
    createdAt: timestamps[0] ?? generatedAt,
    models: unique(trials.map((trial) => trial.model)),
    variants: unique(trials.map((trial) => trial.variant)),
    sourceCommits: unique(trials.map((trial) => trial.sourceCommit)),
    trialCount: trials.length,
    taskCount: new Set(trials.map((trial) => trial.task)).size,
    passed: trials.filter((trial) => trial.passed).length,
    flagged: trials.filter((trial) => trial.flags.length > 0).length,
    meanReward:
      rewards.length === 0
        ? null
        : rewards.reduce((total, value) => total + value, 0) / rewards.length,
    indexPath: `./runs/${first.runSlug}/index.json`,
  }
}

function toTrialSummary(trial: BenchmarkTrial): BenchmarkTrialSummary {
  const { trace, ...summary } = trial
  return {
    ...summary,
    traceLength: trace.length,
    detailPath: `./runs/${trial.runSlug}/trials/${trial.slug}.json`,
  }
}

async function existingCatalog(outputDir: string): Promise<BenchmarkCatalog | null> {
  try {
    const parsed = safeJsonParse(
      await readFile(resolve(outputDir, 'catalog.json'), 'utf8'),
      decodeWithSchema(benchmarkCatalogSchema),
    )
    if (!parsed) throw new Error('existing benchmark catalog has an unsupported shape')
    return parsed
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return null
    }
    throw error
  }
}

function mergedCatalog(
  existing: BenchmarkCatalog | null,
  incoming: BenchmarkCatalog,
): BenchmarkCatalog {
  if (!existing) return incoming
  const runs = new Map(existing.runs.map((run) => [run.slug, run]))
  for (const run of incoming.runs) runs.set(run.slug, run)
  return {
    ...incoming,
    sources: unique([...existing.sources, ...incoming.sources]),
    runs: [...runs.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.slug.localeCompare(right.slug),
    ),
    warnings: unique([...existing.warnings, ...incoming.warnings]),
  }
}

export async function buildBenchmarkData(
  options: BuildBenchmarkDataOptions,
): Promise<BenchmarkData> {
  if (options.artifactRoots.length === 0) throw new Error('at least one artifact root is required')
  const floor = options.lowWorkFloor ?? DEFAULT_LOW_WORK_FLOOR
  const generatedAt = (options.generatedAt ?? new Date()).toISOString()
  const warnings: string[] = []
  const trials: BenchmarkTrial[] = []
  const roots = options.artifactRoots.map((root) => resolve(root))

  for (const root of roots) {
    let paths: string[]
    try {
      paths = await collectInputPaths(root)
    } catch (error) {
      warnings.push(`${basename(root)}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const path of paths) {
      const label = relative(root, path)
      const text = await readFile(path, 'utf8')
      if (basename(path) === 'manifest.json') {
        const manifest = safeJsonParse(text, decodeWithSchema(skillsManifestSchema))
        if (!manifest) {
          warnings.push(`${label}: invalid SkillsBench manifest`)
          continue
        }
        let trace: TraceMessage[] = []
        try {
          trace = foldTrace(resolve(dirname(path), 'thread'))
        } catch (error) {
          warnings.push(
            `${label}: could not fold trace (${error instanceof Error ? error.message : String(error)})`,
          )
        }
        trials.push(skillsTrial(manifest, path, root, trace, floor))
      } else {
        const manifest = safeJsonParse(text, decodeWithSchema(terminalManifestSchema))
        if (!manifest) {
          warnings.push(`${label}: invalid Terminal-Bench run manifest`)
          continue
        }
        let trace: TraceMessage[] = []
        try {
          trace = foldTrace(resolve(dirname(path), 'agent/thread'))
        } catch (error) {
          warnings.push(
            `${label}: could not fold trace (${error instanceof Error ? error.message : String(error)})`,
          )
        }
        trials.push(terminalTrial(manifest, trace, floor))
      }
    }
  }

  trials.sort((left, right) =>
    [left.runSlug, left.task, left.variant, left.attempt, left.id]
      .join('\0')
      .localeCompare(
        [right.runSlug, right.task, right.variant, right.attempt, right.id].join('\0'),
      ),
  )
  const grouped = new Map<string, BenchmarkTrial[]>()
  for (const trial of trials) {
    const selected = grouped.get(trial.runSlug)
    if (selected) selected.push(trial)
    else grouped.set(trial.runSlug, [trial])
  }
  const runs = [...grouped.values()]
    .map((runTrials) => ({ summary: summarizeRun(runTrials, generatedAt), trials: runTrials }))
    .sort(
      (left, right) =>
        right.summary.createdAt.localeCompare(left.summary.createdAt) ||
        left.summary.slug.localeCompare(right.summary.slug),
    )
  return {
    catalog: {
      schemaVersion: 1,
      generatedAt,
      sources: roots.map((root) => basename(root)),
      lowWorkFloor: floor,
      runs: runs.map((run) => run.summary),
      warnings,
    },
    runs,
  }
}

export async function buildBenchmarkSite(
  options: BuildBenchmarkSiteOptions,
): Promise<BenchmarkData> {
  const data = await buildBenchmarkData(options)
  const outputDir = resolve(options.outputDir)
  const catalog = options.append
    ? mergedCatalog(await existingCatalog(outputDir), data.catalog)
    : data.catalog
  await mkdir(resolve(outputDir, 'assets'), { recursive: true })
  await Promise.all(
    VIEWER_ASSETS.map((asset) => copyFile(asset.source, resolve(outputDir, asset.output))),
  )
  for (const run of data.runs) {
    const runDirectory = resolve(outputDir, 'runs', run.summary.slug)
    await mkdir(resolve(runDirectory, 'trials'), { recursive: true })
    const index: BenchmarkRunIndex = {
      schemaVersion: 1,
      run: run.summary,
      trials: run.trials.map(toTrialSummary),
    }
    await writeFile(resolve(runDirectory, 'index.json'), `${JSON.stringify(index)}\n`)
    await Promise.all(
      run.trials.map((trial) =>
        writeFile(
          resolve(runDirectory, 'trials', `${trial.slug}.json`),
          `${JSON.stringify(trial)}\n`,
        ),
      ),
    )
  }
  await writeFile(resolve(outputDir, 'catalog.json'), `${JSON.stringify(catalog)}\n`)
  return { ...data, catalog }
}
