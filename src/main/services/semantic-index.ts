import { cpus } from 'node:os'
import * as fsp from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { getBundledCodesearchPath } from './bundled-semantic.ts'
import { runCommand, type RunCommandOptions } from './command-runner.ts'
import { COMMAND_RUNNER_LONG_TIMEOUT_MS } from './subprocess-output-cap.ts'
import { toRelativePath } from './workspace.ts'

const LEGACY_CODESEARCH_DB_DIR = '.codesearch.db'

/**
 * Hard ceiling on codesearch worker threads. Without a cap the native indexer
 * fans out across every core (we observed >600% CPU, #517), starving the rest
 * of the app. Cap to at most {@link CODESEARCH_MAX_THREADS} *and* at most half
 * the machine's cores so a background index never monopolises the CPU.
 */
const CODESEARCH_MAX_THREADS = 4

/**
 * Bound how long an index/search may run. The CPU cap stops codesearch pinning
 * every core, and this stops it pinning *some* cores for minutes on end (#517).
 * Indexing a fresh repo is the slow path, so it gets the larger budget.
 */
const CODESEARCH_INDEX_TIMEOUT_MS = 5 * 60_000
const CODESEARCH_SEARCH_TIMEOUT_MS = 60_000

/** Number of worker threads codesearch may use, capped for CPU fairness (#517). */
export function codesearchThreadCap(): number {
  const cores = Math.max(1, cpus().length)
  return Math.max(1, Math.min(CODESEARCH_MAX_THREADS, Math.floor(cores / 2)))
}

/**
 * Env vars that cap thread fan-out for the codesearch process. The binary is
 * Rust/tokio based, so we constrain the common thread-pool knobs (Rayon, tokio,
 * OpenMP) rather than relying on a CLI flag that may change between releases.
 */
export function codesearchCpuLimitEnv(): NodeJS.ProcessEnv {
  const threads = String(codesearchThreadCap())
  return {
    RAYON_NUM_THREADS: threads,
    TOKIO_WORKER_THREADS: threads,
    OMP_NUM_THREADS: threads,
    CODESEARCH_THREADS: threads,
  }
}

export type SemanticBackend = 'codesearch' | 'vera'

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
let codesearchCommand: string | null = null
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
let indexUpdateRunnerForTest:
  | ((backend: SemanticBackend, root: string) => Promise<void>)
  | null = null

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
  codesearchCommand = null

  const codesearchCandidates = ['codesearch', getBundledCodesearchPath()].filter(
    (cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0,
  )
  for (const cmd of codesearchCandidates) {
    if (await probe(cmd, ['--version'])) {
      codesearchCommand = cmd
      activeBackend = 'codesearch'
      return 'codesearch'
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

export function getCodesearchCommand(): string | null {
  return codesearchCommand
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { code } = await runCommand(cmd, args, SEMANTIC_CMD_OPTS)
    return code === 0
  } catch {
    return false
  }
}

function codesearchCmd(): string {
  if (!codesearchCommand) throw new Error('codesearch backend is not configured')
  return codesearchCommand
}

/** Synthetic HOME so codesearch global indexes live under Copse userData, not the workspace. */
export function codesearchHomeDir(): string {
  return join(app.getPath('userData'), 'codesearch')
}

function codesearchRunOpts(
  workspaceRoot: string,
  extra: Omit<RunCommandOptions, 'cwd' | 'env'> = {},
): RunCommandOptions {
  return {
    cwd: workspaceRoot,
    ...SEMANTIC_CMD_OPTS,
    // Default to the search budget; index calls override timeout_ms via `extra`.
    timeout_ms: CODESEARCH_SEARCH_TIMEOUT_MS,
    // Cap thread fan-out so the indexer can't pin every core (#517). The env
    // knobs only bind if the binary uses default rayon/tokio pools, so also drop
    // the process priority — that keeps codesearch from starving the UI (typing
    // lag) regardless of whether it honours the thread caps.
    lowPriority: true,
    env: { HOME: codesearchHomeDir(), ...codesearchCpuLimitEnv() },
    ...extra,
  }
}

async function removeLegacyCodesearchDb(workspaceRoot: string): Promise<void> {
  try {
    await fsp.rm(join(workspaceRoot, LEGACY_CODESEARCH_DB_DIR), { recursive: true, force: true })
  } catch {
    /* best-effort migration from pre-global local indexes */
  }
}

/** Resolve a semantic search scope path without breaking on "." or absolute paths. */
export function resolveSemanticSearchRoot(workspaceRoot: string, filterPath?: string): string {
  if (!filterPath || filterPath === '.') return workspaceRoot
  const root = resolve(workspaceRoot)
  const scoped = resolve(root, filterPath)
  if (scoped === root) return root
  if (scoped.startsWith(`${root}${sep}`)) return scoped
  return root
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
        case 'codesearch':
          await ensureCodesearchIndex(root)
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
 * spawns a fresh codesearch process on every burst of file changes — and since
 * an index can run for minutes, those processes stack and pin every core (#517),
 * defeating the per-process thread cap and lagging the UI.
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
      case 'codesearch':
        await runCommand(
          codesearchCmd(),
          ['index', root],
          codesearchRunOpts(root, { timeout_ms: CODESEARCH_INDEX_TIMEOUT_MS }),
        )
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
    case 'codesearch':
      return searchWithCodesearch(opts)
    case 'vera':
      return searchWithVera(opts)
  }
}

async function ensureCodesearchIndex(workspaceRoot: string): Promise<void> {
  const cmd = codesearchCmd()
  const opts = codesearchRunOpts(workspaceRoot, { timeout_ms: CODESEARCH_INDEX_TIMEOUT_MS })
  try {
    await runCommand(cmd, ['index', 'add', '-g', workspaceRoot], opts)
  } catch {
    await runCommand(cmd, ['index', workspaceRoot], opts)
  }
  await removeLegacyCodesearchDb(workspaceRoot)
}

async function ensureVeraIndex(workspaceRoot: string): Promise<void> {
  await runCommand(veraCommand, ['index', workspaceRoot], {
    cwd: workspaceRoot,
    ...SEMANTIC_CMD_OPTS,
  })
}

async function searchWithCodesearch(
  opts: SemanticSearchOptions,
): Promise<{ hits: SemanticSearchHit[]; backend: SemanticBackend }> {
  const searchRoot = resolveSemanticSearchRoot(opts.workspaceRoot, opts.filterPath)

  const args = [
    'search',
    opts.query,
    '--json',
    '--content',
    '--max-results',
    String(opts.maxResults),
    '--path',
    searchRoot,
  ]

  const { stdout } = await runCommand(
    codesearchCmd(),
    args,
    codesearchRunOpts(opts.workspaceRoot, opts.signal ? { signal: opts.signal } : {}),
  )

  return { hits: parseCodesearchJson(stdout, opts.maxResults), backend: 'codesearch' }
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

export function parseCodesearchJson(stdout: string, maxResults: number): SemanticSearchHit[] {
  const parsed = parseJsonPayload(stdout)
  const items = extractResultItems(parsed)
  return items
    .map(normalizeCodesearchHit)
    .filter((hit): hit is SemanticSearchHit => hit !== null)
    .slice(0, maxResults)
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

function normalizeCodesearchHit(item: unknown): SemanticSearchHit | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const path = readString(record, ['path', 'file', 'filename'])
  if (!path) return null

  const startLine = readNumber(record, ['start_line', 'line', 'line_number']) ?? 1
  const endLine = readNumber(record, ['end_line', 'endLine'])
  const text =
    readString(record, ['snippet', 'content', 'text', 'signature']) ??
    readString(record, ['summary']) ??
    ''
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
