import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { getBundledGortexPath } from './bundled-semantic.ts'
import { runCommand, type RunCommandOptions } from '../exec/command-runner.ts'
import { COMMAND_RUNNER_LONG_TIMEOUT_MS } from '../exec/subprocess-output-cap.ts'
import { toRelativePath } from '../workspace.ts'

/**
 * Hard ceiling on semantic-index worker threads. Without a cap the native
 * indexer fans out across every core (we observed >600% CPU, #517), starving
 * the rest of the app. Cap to at most {@link SEMANTIC_MAX_THREADS} *and* at most
 * half the machine's cores so a background index never monopolises the CPU.
 */
const SEMANTIC_MAX_THREADS = 4

/**
 * Bound how long an index/search may run. The CPU cap stops the indexer pinning
 * every core, and this stops it pinning *some* cores for minutes on end (#517).
 * Indexing a fresh repo is the slow path, so it gets the larger budget.
 */
const SEMANTIC_INDEX_TIMEOUT_MS = 5 * 60_000
const SEMANTIC_SEARCH_TIMEOUT_MS = 60_000

/** Number of worker threads the indexer may use, capped for CPU fairness (#517). */
export function semanticThreadCap(): number {
  const cores = Math.max(1, cpus().length)
  return Math.max(1, Math.min(SEMANTIC_MAX_THREADS, Math.floor(cores / 2)))
}

/**
 * Cap thread fan-out for the gortex daemon/CLI. gortex is a single static Go
 * binary, so GOMAXPROCS is the one release-robust knob that bounds its
 * scheduler and keeps a background index from pinning every core (#517).
 */
export function gortexCpuLimitEnv(): NodeJS.ProcessEnv {
  return { GOMAXPROCS: String(semanticThreadCap()) }
}

export type SemanticBackend = 'gortex' | 'vera'

export interface SemanticSearchOptions {
  query: string
  workspaceRoot: string
  filterPath?: string
  maxResults: number
  signal?: AbortSignal
}

export interface SemanticSearchHit {
  path: string
  startLine: number
  endLine?: number
  text: string
  score?: number
}

let activeBackend: SemanticBackend | null = null
let gortexCommand: string | null = null
/** One daemon spawn per app session; reset on failure so a retry can respawn. */
let gortexDaemonReady: Promise<boolean> | null = null
let veraCommand = 'vera'
const indexPromises = new Map<string, Promise<void>>()
/** Roots with an in-flight {@link updateSemanticIndex} run, for overlap-free coalescing. */
const updateInFlight = new Map<string, Promise<void>>()
/** Roots that received an update request while a run was already in flight. */
const updatePending = new Set<string>()

const SEMANTIC_CMD_OPTS = {
  unsandboxed: true,
  timeout_ms: COMMAND_RUNNER_LONG_TIMEOUT_MS,
} as const
let searchExecutorForTest:
  | ((
      opts: SemanticSearchOptions,
    ) => Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend } | null>)
  | null = null
let indexUpdateRunnerForTest: ((backend: SemanticBackend, root: string) => Promise<void>) | null =
  null

/** Test hook — replace the per-run index worker to assert coalescing without spawning. */
export function setSemanticIndexUpdateRunnerForTest(
  runner: ((backend: SemanticBackend, root: string) => Promise<void>) | null,
): void {
  indexUpdateRunnerForTest = runner
}

export function getSemanticBackend(): SemanticBackend | null {
  return activeBackend
}

export function isSemanticSearchAvailable(): boolean {
  return activeBackend !== null
}

/** Test hook — force backend without probing PATH. */
export function setSemanticBackendForTest(backend: SemanticBackend | null): void {
  activeBackend = backend
}

/** Test hook — bypass CLI and return canned semantic hits. */
export function setSemanticSearchExecutorForTest(
  executor:
    | ((
        opts: SemanticSearchOptions,
      ) => Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend } | null>)
    | null,
): void {
  searchExecutorForTest = executor
}

export async function probeSemanticBackends(): Promise<SemanticBackend | null> {
  gortexCommand = null
  gortexDaemonReady = null

  // gortex has no `--version` flag; `gortex version` exits 0 without a daemon.
  const gortexCandidates = ['gortex', getBundledGortexPath()].filter(
    (cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0,
  )
  for (const cmd of gortexCandidates) {
    if (await probe(cmd, ['version'])) {
      gortexCommand = cmd
      activeBackend = 'gortex'
      return 'gortex'
    }
  }

  if (await probe('vera', ['--version'])) {
    veraCommand = 'vera'
    activeBackend = 'vera'
    return 'vera'
  }

  activeBackend = null
  return null
}

/** Whether the active semantic backend resolved to a binary we bundled (vs PATH). */
export function isSemanticBackendBundled(): boolean {
  if (activeBackend === 'gortex') return gortexCommand === getBundledGortexPath()
  return false
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { code } = await runCommand(cmd, args, SEMANTIC_CMD_OPTS)
    return code === 0
  } catch {
    return false
  }
}

function gortexCmd(): string {
  if (!gortexCommand) throw new Error('gortex backend is not configured')
  return gortexCommand
}

/** Synthetic HOME so gortex daemon state/indexes live under Copse userData, not the workspace. */
export function gortexHomeDir(): string {
  return join(app.getPath('userData'), 'gortex')
}

function gortexRunOpts(
  workspaceRoot: string,
  extra: Omit<RunCommandOptions, 'cwd' | 'env'> = {},
): RunCommandOptions {
  return {
    cwd: workspaceRoot,
    ...SEMANTIC_CMD_OPTS,
    timeout_ms: SEMANTIC_SEARCH_TIMEOUT_MS,
    lowPriority: true,
    // HOME scopes ~/.gortex (daemon socket hash, sqlite store, config) to our
    // userData dir; GOMAXPROCS bounds the Go scheduler so a background index
    // can't pin every core (#517).
    env: { HOME: gortexHomeDir(), ...gortexCpuLimitEnv() },
    ...extra,
  }
}

/**
 * Unlike vera, gortex is daemon-based: `track` and `call` fail hard
 * when no daemon is listening, and `daemon start --detach` exits non-zero when
 * one already is. Probe status first, spawn once per app session, and re-check
 * status after a failed spawn so a lost start race still counts as ready.
 */
async function ensureGortexDaemon(workspaceRoot: string): Promise<boolean> {
  const existing = gortexDaemonReady
  if (existing) return existing

  const startup = (async (): Promise<boolean> => {
    const cmd = gortexCmd()
    const statusArgs = ['daemon', 'status', '--no-progress']
    if (await probeWithOpts(cmd, statusArgs, gortexRunOpts(workspaceRoot))) return true
    await runCommand(
      cmd,
      ['daemon', 'start', '--detach', '--no-progress'],
      gortexRunOpts(workspaceRoot),
    ).catch(() => undefined)
    return probeWithOpts(cmd, statusArgs, gortexRunOpts(workspaceRoot))
  })()

  gortexDaemonReady = startup
  const ready = await startup.catch(() => false)
  if (!ready && gortexDaemonReady === startup) gortexDaemonReady = null
  return ready
}

async function probeWithOpts(
  cmd: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<boolean> {
  try {
    const { code } = await runCommand(cmd, args, opts)
    return code === 0
  } catch {
    return false
  }
}

/** Register and build the semantic index when a workspace opens. */
export async function ensureSemanticIndex(workspaceRoot: string): Promise<void> {
  const backend = activeBackend
  if (!backend) return

  const root = resolve(workspaceRoot)
  const existing = indexPromises.get(root)
  if (existing) {
    await existing
    return
  }

  const promise = (async (): Promise<void> => {
    try {
      switch (backend) {
        case 'gortex':
          await ensureGortexIndex(root)
          break
        case 'vera':
          await ensureVeraIndex(root)
          break
      }
    } catch (err) {
      console.warn('[copse-panel] semantic index setup failed:', err)
    }
  })()

  indexPromises.set(root, promise)
  try {
    await promise
  } finally {
    if (indexPromises.get(root) === promise) indexPromises.delete(root)
  }
}

/**
 * Incrementally update the semantic index after workspace file changes.
 *
 * Coalesced per root: at most one update runs at a time, and any requests that
 * arrive while one is in flight collapse into a single trailing run. Without
 * this, the recursive workspace watcher (which only debounces *scheduling*)
 * spawns a fresh index pass on every burst of file changes — and since an index
 * can run for minutes, those runs stack and pin every core (#517), defeating the
 * per-process thread cap and lagging the UI.
 */
export async function updateSemanticIndex(workspaceRoot: string): Promise<void> {
  const backend = activeBackend
  if (!backend) return

  const root = resolve(workspaceRoot)
  const existing = updateInFlight.get(root)
  if (existing) {
    // A run owns this root; ask it to do one more pass and ride its promise.
    updatePending.add(root)
    await existing
    return
  }

  const run = (async (): Promise<void> => {
    try {
      do {
        updatePending.delete(root)
        await (indexUpdateRunnerForTest ?? runSemanticIndexUpdate)(backend, root)
      } while (updatePending.has(root))
    } finally {
      updateInFlight.delete(root)
      updatePending.delete(root)
    }
  })()
  updateInFlight.set(root, run)
  await run
}

async function runSemanticIndexUpdate(backend: SemanticBackend, root: string): Promise<void> {
  try {
    switch (backend) {
      case 'gortex':
        // Re-`track` is idempotent: the daemon diffs against its sqlite store
        // and re-indexes only what changed; --wait bounds it like an index run.
        await ensureGortexIndex(root)
        break
      case 'vera':
        await runCommand(veraCommand, ['update', root], {
          cwd: root,
          ...SEMANTIC_CMD_OPTS,
        })
        break
    }
  } catch (err) {
    console.warn('[copse-panel] semantic index update failed:', err)
  }
}

export async function searchSemanticContent(
  opts: SemanticSearchOptions,
): Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend } | null> {
  if (searchExecutorForTest) return searchExecutorForTest(opts)

  const backend = activeBackend
  if (!backend) return null

  await ensureSemanticIndex(opts.workspaceRoot)

  switch (backend) {
    case 'gortex':
      return searchWithGortex(opts)
    case 'vera':
      return searchWithVera(opts)
  }
}

async function ensureGortexIndex(workspaceRoot: string): Promise<void> {
  if (!(await ensureGortexDaemon(workspaceRoot))) {
    throw new Error('gortex daemon failed to start')
  }
  // --wait blocks until the graph is queryable so the first search after a
  // workspace opens doesn't race a cold index.
  await runCommand(
    gortexCmd(),
    ['track', workspaceRoot, '--wait', '--wait-timeout', '5m', '--no-progress'],
    gortexRunOpts(workspaceRoot, { timeout_ms: SEMANTIC_INDEX_TIMEOUT_MS }),
  )
}

async function ensureVeraIndex(workspaceRoot: string): Promise<void> {
  await runCommand(veraCommand, ['index', workspaceRoot], {
    cwd: workspaceRoot,
    ...SEMANTIC_CMD_OPTS,
  })
}

/**
 * Query gortex's `search_symbols` MCP tool through the generic `call` verb —
 * the daemon's hybrid (BM25 + embedding) ranker over the indexed graph. The
 * argument object goes through `--json` rather than `--arg` so a query that
 * happens to start with `{`/`[` or contain `=` is never mis-coerced.
 *
 * search_symbols has no path-scope parameter, so a filterPath widens the
 * requested limit and filters client-side in {@link parseGortexJson}.
 */
async function searchWithGortex(
  opts: SemanticSearchOptions,
): Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend }> {
  const fetchLimit = opts.filterPath ? Math.min(200, opts.maxResults * 5) : opts.maxResults

  const args = [
    'call',
    'search_symbols',
    '--index',
    opts.workspaceRoot,
    '--format',
    'json',
    '--no-progress',
    '--json',
    JSON.stringify({ q: opts.query, limit: fetchLimit }),
  ]

  const { stdout } = await runCommand(
    gortexCmd(),
    args,
    gortexRunOpts(opts.workspaceRoot, opts.signal ? { signal: opts.signal } : {}),
  )

  return {
    hits: parseGortexJson(stdout, opts.maxResults, opts.filterPath),
    backend: 'gortex',
  }
}

async function searchWithVera(
  opts: SemanticSearchOptions,
): Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend }> {
  const args = [
    'search',
    opts.query,
    '--json',
    '--limit',
    String(opts.maxResults),
    ...(opts.filterPath ? ['--path', opts.filterPath] : []),
  ]

  const { stdout } = await runCommand(veraCommand, args, {
    cwd: opts.workspaceRoot,
    ...SEMANTIC_CMD_OPTS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  return { hits: parseVeraJson(stdout, opts.maxResults), backend: 'vera' }
}

export function parseGortexJson(
  stdout: string,
  maxResults: number,
  filterPath?: string,
): SemanticSearchHit[] {
  const parsed = parseJsonPayload(stdout)
  const items = extractResultItems(parsed)
  const hits = items.map(normalizeGortexHit).filter((hit): hit is SemanticSearchHit => hit !== null)
  const scoped =
    filterPath && filterPath !== '.'
      ? hits.filter((hit) => hit.path === filterPath || hit.path.startsWith(`${filterPath}/`))
      : hits
  return scoped.slice(0, maxResults)
}

export function parseVeraJson(stdout: string, maxResults: number): SemanticSearchHit[] {
  const parsed = parseJsonPayload(stdout)
  const items = extractResultItems(parsed)
  return items
    .map(normalizeVeraHit)
    .filter((hit): hit is SemanticSearchHit => hit !== null)
    .slice(0, maxResults)
}

function parseJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    const start = trimmed.indexOf('{')
    const arrayStart = trimmed.indexOf('[')
    const idx = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart)
    if (idx === -1) return null
    try {
      return JSON.parse(trimmed.slice(idx)) as unknown
    } catch {
      return null
    }
  }
}

function extractResultItems(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object' || parsed === null) return []

  const record = parsed as Record<string, unknown>
  if (Array.isArray(record['results'])) return record['results']
  if (Array.isArray(record['matches'])) return record['matches']
  if (Array.isArray(record['hits'])) return record['hits']
  return []
}

/**
 * Shape observed from `gortex call search_symbols --format json` (v0.58.3):
 * `{ results: [{ absolute_file_path, file_path, start_line, name, kind, doc?, id, … }] }`.
 * `absolute_file_path` is preferred — `file_path` is repo-relative and
 * toRelativePath would resolve it against the process cwd instead. Hits are
 * symbols (no end_line/snippet); `doc` is the symbol's docstring when indexed.
 */
function normalizeGortexHit(item: unknown): SemanticSearchHit | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const path = readString(record, ['absolute_file_path', 'file_path', 'path', 'file'])
  if (!path) return null

  const startLine = readNumber(record, ['start_line', 'line', 'line_number']) ?? 1
  const endLine = readNumber(record, ['end_line', 'endLine'])
  const name = readString(record, ['name']) ?? ''
  const kind = readString(record, ['kind']) ?? ''
  const doc = readString(record, ['doc', 'snippet', 'content', 'signature']) ?? ''
  const symbol = [kind, name].filter(Boolean).join(' ')
  const text = [symbol, doc].filter(Boolean).join(' — ')
  const score = readNumber(record, ['score', 'rrf_score', 'relevance'])

  return {
    path: toRelativePath(path),
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    text: text.trim(),
    ...(score !== undefined ? { score } : {}),
  }
}

function normalizeVeraHit(item: unknown): SemanticSearchHit | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const path = readString(record, ['path', 'file', 'filename'])
  if (!path) return null

  const startLine = readNumber(record, ['line', 'start_line', 'line_number']) ?? 1
  const endLine = readNumber(record, ['end_line', 'endLine'])
  const text = readString(record, ['snippet', 'content', 'text', 'signature', 'preview']) ?? ''
  const score = readNumber(record, ['score', 'rerank_score', 'relevance'])

  return {
    path: toRelativePath(path),
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    text: text.trim(),
    ...(score !== undefined ? { score } : {}),
  }
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

export function formatSemanticSearchResults(
  hits: SemanticSearchHit[],
  maxResults: number,
  backend: SemanticBackend,
): string {
  if (hits.length === 0) return 'No matches found.'

  const lines = hits.map((hit) => {
    const range =
      hit.endLine && hit.endLine !== hit.startLine
        ? `${String(hit.startLine)}-${String(hit.endLine)}`
        : String(hit.startLine)
    const score = hit.score !== undefined ? ` score=${hit.score.toFixed(3)}` : ''
    const body = hit.text ? `: ${hit.text}` : ''
    return `${hit.path}:${range}${body}${score}`
  })

  const suffix =
    hits.length >= maxResults
      ? `\n[Truncated at ${String(maxResults)} results. Narrow your search.]`
      : ''
  return lines.join('\n') + suffix + `\n[Searched via native ${backend} backend.]`
}
