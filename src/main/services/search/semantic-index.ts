import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { getBundledGortexPath } from './bundled-semantic.ts'
import { GORTEX_EXCLUDE_PATTERNS } from './index-ignore.ts'
import { computeGitIgnoreExcludes } from './git-derived-excludes.ts'
import { runCommand, type RunCommandOptions } from '../exec/command-runner.ts'
import { COMMAND_RUNNER_LONG_TIMEOUT_MS } from '../exec/subprocess-output-cap.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { toRelativePath } from '../workspace.ts'
import {
  indexBuildStarted,
  indexBuildFinished,
  setSemanticIndexUnavailable,
} from './index-status.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'

/**
 * Hard ceiling on semantic-index worker threads. Without a cap the native
 * indexer fans out across every core (we observed >600% CPU, #517), starving
 * the rest of the app. Cap to at most {@link SEMANTIC_MAX_THREADS} *and* at most
 * half the machine's cores so a background index never monopolises the CPU.
 */
const SEMANTIC_MAX_THREADS = 4

/**
 * How long `gortex track --wait` blocks for the freshly-tracked graph to become
 * queryable before it stops waiting. gortex is daemon-based, so when this budget
 * elapses the detached daemon keeps indexing in the background — the wait timing
 * out means "not queryable yet", not "indexing failed".
 */
const SEMANTIC_INDEX_WAIT_MS = 5 * 60_000

/**
 * Grace margin between gortex's own `--wait-timeout` and the command runner's
 * hard-kill. gortex returning on its own is the graceful path; the kill turns
 * that benign return into a thrown `Command timed out` error (which then flips
 * the index status to `error`). The margin must be big enough that a healthy
 * gortex client always exits first.
 */
const SEMANTIC_INDEX_KILL_GRACE_MS = 30_000

/**
 * Hard ceiling on the whole `track` invocation — the command runner SIGKILLs
 * the process tree at this point (#517). It must exceed {@link
 * SEMANTIC_INDEX_WAIT_MS} by {@link SEMANTIC_INDEX_KILL_GRACE_MS}: equal budgets
 * (both were 5m) raced, and the kill usually won, so every file-change burst
 * turned a still-indexing repo into a `semantic index update failed` error
 * instead of letting gortex's `--wait-timeout` return gracefully.
 */
const SEMANTIC_INDEX_TIMEOUT_MS = SEMANTIC_INDEX_WAIT_MS + SEMANTIC_INDEX_KILL_GRACE_MS
const SEMANTIC_SEARCH_TIMEOUT_MS = 60_000

/** gortex `--wait-timeout` argument, derived from {@link SEMANTIC_INDEX_WAIT_MS} so the two never drift. */
export function gortexIndexWaitArg(): string {
  return `${String(Math.round(SEMANTIC_INDEX_WAIT_MS / 60_000))}m`
}

/** Command-runner hard-kill ceiling for a `gortex track` run; exposed for the timeout-invariant test. */
export function gortexIndexKillTimeoutMs(): number {
  return SEMANTIC_INDEX_TIMEOUT_MS
}

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

/**
 * Soft memory ceiling for the gortex daemon (Go's `GOMEMLIMIT`). A backstop only:
 * repo scoping (see {@link scopeGortexToActiveRepo}) keeps the tracked set to the
 * active workspace, but if that ever regresses this bounds the Go heap so the
 * daemon can't grow without limit and OOM-kill the app. Overridable for large
 * checkouts via `COPSE_GORTEX_MEM_LIMIT` (e.g. `6GiB`).
 */
const GORTEX_MEM_LIMIT = process.env['COPSE_GORTEX_MEM_LIMIT'] ?? '4GiB'

export function gortexMemLimitEnv(): NodeJS.ProcessEnv {
  return { GOMEMLIMIT: GORTEX_MEM_LIMIT }
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
/** gortex excludes are written to its config once per app session (idempotent). */
let gortexExcludesReady: Promise<void> | null = null

/**
 * Sentinel filename (under {@link gortexHomeDir}) marking that this install has
 * dropped its pre-exclude index once. Bump the suffix to force another reset
 * after changing {@link GORTEX_EXCLUDE_PATTERNS}.
 */
const GORTEX_EXCLUDE_RESET_SENTINEL = '.copse-exclude-reset-v1'
let veraCommand = 'vera'
const indexPromises = new Map<string, Promise<void>>()
/**
 * Roots whose index completed at least one successful build/update pass this
 * session. Until a root is here, a semantic search would block on the cold
 * build (up to {@link SEMANTIC_INDEX_TIMEOUT_MS}, #517) — callers check
 * {@link isSemanticIndexReady} and fall back to text search instead.
 */
const readyRoots = new Set<string>()
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
  if (isActiveSshWorkspace()) return false
  return activeBackend !== null
}

/** Whether this root's semantic index has completed a build pass this session. */
export function isSemanticIndexReady(workspaceRoot: string): boolean {
  return readyRoots.has(resolve(workspaceRoot))
}

/** Test hook — mark a root ready (or clear all readiness with null). */
export function setSemanticIndexReadyForTest(workspaceRoot: string | null): void {
  if (workspaceRoot === null) readyRoots.clear()
  else readyRoots.add(resolve(workspaceRoot))
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
  gortexExcludesReady = null

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
  setSemanticIndexUnavailable()
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
  return join(getElectronUserDataPath(), 'gortex')
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
    // can't pin every core (#517); GOMEMLIMIT caps the daemon's heap so a
    // runaway index can't OOM the machine. The daemon inherits this env from the
    // `daemon start` invocation, so the ceiling applies for its whole lifetime.
    env: { HOME: gortexHomeDir(), ...gortexCpuLimitEnv(), ...gortexMemLimitEnv() },
    ...extra,
  }
}

/** How long to wait for a freshly-spawned daemon to bind its socket. */
const DAEMON_READY_TIMEOUT_MS = 10_000
/** Poll interval while waiting for the daemon socket after `daemon start`. */
const DAEMON_READY_POLL_MS = 250

/**
 * Unlike vera, gortex is daemon-based: `track` and `call` fail hard
 * when no daemon is listening, and `daemon start --detach` exits non-zero when
 * one already is. Probe status first, spawn once per app session, then poll
 * status until the socket is up.
 *
 * `daemon start --detach` returns as soon as the child is forked — the daemon
 * binds its unix socket a beat later — so a single immediate status check races
 * the socket creation and reports "daemon failed to start" for a daemon that is
 * in fact coming up. This only bites when the daemon isn't already running
 * (first launch, post-reboot, after a crash/kill), since a live daemon persists
 * across app sessions and short-circuits at the first status probe.
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
    // Poll rather than check once: the detached daemon isn't reachable the
    // instant `start` returns.
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
    for (;;) {
      if (await probeWithOpts(cmd, statusArgs, gortexRunOpts(workspaceRoot))) return true
      if (Date.now() >= deadline) return false
      await delay(DAEMON_READY_POLL_MS)
    }
  })()

  gortexDaemonReady = startup
  const ready = await startup.catch(() => false)
  if (!ready && gortexDaemonReady === startup) gortexDaemonReady = null
  return ready
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  if (isActiveSshWorkspace()) return
  const backend = activeBackend
  if (!backend) return

  const root = resolve(workspaceRoot)
  const existing = indexPromises.get(root)
  if (existing) {
    await existing
    return
  }

  const promise = (async (): Promise<void> => {
    indexBuildStarted('semantic')
    try {
      switch (backend) {
        case 'gortex':
          await ensureGortexIndex(root)
          break
        case 'vera':
          await ensureVeraIndex(root)
          break
      }
      readyRoots.add(root)
      indexBuildFinished('semantic', true)
    } catch (err) {
      indexBuildFinished('semantic', false)
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
  if (isActiveSshWorkspace()) return
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
  indexBuildStarted('semantic')
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
    readyRoots.add(root)
    indexBuildFinished('semantic', true)
  } catch (err) {
    indexBuildFinished('semantic', false)
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

/**
 * Register gortex's ignore list and shed any pre-exclude index, once per app
 * session. Memoised on a shared promise so concurrent ensure/update passes for
 * different roots don't race the config writes or the one-time reset.
 *
 * gortex does not honor `.gitignore`, so without this it walks the entire
 * workspace — node_modules, dist, vendored binaries, `.git`, and the ephemeral
 * agent worktrees, ~3 GB on a dev checkout — and a single `track --wait` never
 * settles inside its window (#517 follow-up). `config exclude` bounds both
 * indexing and gortex's own watcher; `--global` writes `~/.gortex/config.yaml`,
 * which our {@link gortexHomeDir} HOME override scopes to Copse userData, so we
 * never drop a `.gortex.yaml` into the user's repo.
 */
/**
 * Excludes already written to gortex's global `config.yaml`, parsed directly
 * (no daemon, no subprocess) so {@link ensureGortexExcludes} can skip re-adding
 * patterns and avoid a spawn-per-pattern storm on every workspace open.
 */
async function readGortexExcludes(): Promise<Set<string>> {
  const out = new Set<string>()
  let raw: string
  try {
    raw = await readFile(join(gortexHomeDir(), '.gortex', 'config.yaml'), 'utf8')
  } catch {
    return out
  }
  let inExclude = false
  for (const line of raw.split('\n')) {
    // Top-level `exclude:` key opens the block; any other non-indented key ends it.
    if (/^\S/.test(line)) inExclude = /^exclude:\s*$/.test(line)
    else if (inExclude) {
      const match = line.match(/^\s*-\s*(.+?)\s*$/)
      if (match?.[1]) out.add(match[1].trim())
    }
  }
  return out
}

async function ensureGortexExcludes(workspaceRoot: string): Promise<void> {
  const existing = gortexExcludesReady
  if (existing) return existing

  const ready = (async (): Promise<void> => {
    // Derive excludes from git (per nested repo) so build output is skipped for
    // any ecosystem without a hardcoded list; union with the small static base
    // for repos that aren't git-tracked and for Copse's own dist-* variants.
    const gitPatterns = await computeGitIgnoreExcludes(workspaceRoot).catch(() => [])
    const patterns = [...new Set<string>([...GORTEX_EXCLUDE_PATTERNS, ...gitPatterns])]
    // Only spawn `exclude add` for patterns NOT already in gortex's config.
    // `exclude add` is one subprocess per call; a dev checkout that has run e2e
    // many times accumulates hundreds of uniquely-named `.wdio-*` dirs, so
    // blindly re-adding every pattern meant hundreds of gortex spawns (plus a
    // re-index) on every workspace open — a startup CPU spin. Reading the
    // current set is a plain file read (no daemon, no spawn); when nothing is
    // new (the common case after the first open) we spawn zero processes and
    // gortex doesn't re-index.
    const present = await readGortexExcludes()
    const missing = patterns.filter((p) => !present.has(p))
    for (const pattern of missing) {
      // Best-effort: a single failed exclude must not block the index build.
      await runCommand(
        gortexCmd(),
        ['config', 'exclude', 'add', pattern, '--global', '--no-progress'],
        gortexRunOpts(workspaceRoot),
      ).catch(() => undefined)
    }
    // Only shed the pre-exclude index when we actually changed the exclude set;
    // otherwise the daemon needn't re-index at all.
    if (missing.length > 0) {
      await resetPreExcludeIndex(workspaceRoot)
    }
  })()

  gortexExcludesReady = ready
  // Don't cache a rejection — let a later pass retry the config writes.
  ready.catch(() => {
    if (gortexExcludesReady === ready) gortexExcludesReady = null
  })
  return ready
}

/**
 * One-time recovery: an index built before the exclude list existed keeps the
 * ~3 GB of node_modules/dist/worktree nodes forever, since adding excludes does
 * not retroactively prune. `untrack` drops the repo so the following `track`
 * rebuilds clean under the new excludes. Gated by a sentinel so it runs once per
 * install; the sentinel is written only on a clean untrack so a mis-invocation
 * retries next session rather than silently marking recovery done.
 */
async function resetPreExcludeIndex(workspaceRoot: string): Promise<void> {
  const sentinel = join(gortexHomeDir(), GORTEX_EXCLUDE_RESET_SENTINEL)
  try {
    await access(sentinel)
    return // already reset on this install
  } catch {
    // no sentinel yet — first run under the exclude regime
  }

  const result = await runCommand(
    gortexCmd(),
    ['untrack', workspaceRoot, '--no-progress'],
    gortexRunOpts(workspaceRoot),
  ).catch(() => null)
  if (!result || result.code !== 0) return

  try {
    await mkdir(gortexHomeDir(), { recursive: true })
    await writeFile(sentinel, `${new Date().toISOString()}\n`)
  } catch {
    // Sentinel is an optimisation; if it can't be written we just reset again.
  }
}

/**
 * Extract the tracked repo paths from gortex's global `config.yaml` (the file
 * `track`/`untrack` edit). Minimal parse of the `repos:` block — we only need the
 * `- path:` entries, not a full YAML dependency, and must not pick up entries
 * from sibling blocks (`exclude:`).
 */
export function parseTrackedRepos(configYaml: string): string[] {
  const paths: string[] = []
  let inRepos = false
  for (const line of configYaml.split('\n')) {
    // A non-indented line starts a new top-level key; we're in `repos:` only
    // while indented list items follow it.
    if (/^\S/.test(line)) inRepos = /^repos:\s*$/.test(line)
    else if (inRepos) {
      const match = line.match(/^\s*-\s*path:\s*(.+?)\s*$/)
      if (match?.[1]) paths.push(match[1])
    }
  }
  return paths
}

/** Which tracked repos to untrack so the daemon is scoped to just `activeRoot`. */
export function reposToUntrackForActive(tracked: string[], activeRoot: string): string[] {
  const active = resolve(activeRoot)
  return tracked.filter((p) => resolve(p) !== active)
}

async function listTrackedGortexRepos(): Promise<string[]> {
  const configPath = join(gortexHomeDir(), '.gortex', 'config.yaml')
  try {
    return parseTrackedRepos(await readFile(configPath, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Scope the shared daemon to the active workspace: untrack every other repo so a
 * large, non-active checkout (a 100k-file monorepo you opened once) can't keep
 * its graph warm and bloat the daemon across sessions. gortex has no per-repo
 * priority knob, so untrack + reload is the lever; the active repo is re-tracked
 * by the caller, and switching workspaces re-indexes the newly-active one.
 */
async function scopeGortexToActiveRepo(activeRoot: string): Promise<void> {
  const others = reposToUntrackForActive(await listTrackedGortexRepos(), activeRoot)
  if (others.length === 0) return
  for (const path of others) {
    await runCommand(
      gortexCmd(),
      ['untrack', path, '--no-progress'],
      gortexRunOpts(activeRoot),
    ).catch(() => undefined)
  }
  // Reload so the daemon drops the untracked graphs and frees their memory now,
  // rather than carrying them until the next restart.
  await runCommand(
    gortexCmd(),
    ['daemon', 'reload', '--no-progress'],
    gortexRunOpts(activeRoot),
  ).catch(() => undefined)
}

/**
 * RSS above which a daemon found at boot is treated as an oversized zombie and
 * reaped. Set to the {@link GORTEX_MEM_LIMIT} ceiling (4 GiB): a daemon this big
 * predates the cap or escaped it (legacy accumulated bloat), so freeing it early
 * — before we allocate our window — avoids a multi-GB resident pushing the
 * machine over its ceiling mid-boot. A scoped, GOMEMLIMIT-capped daemon stays
 * well under this and is reused as-is (no needless re-index); moderate daemons
 * are instead shrunk gracefully by scopeGortexToActiveRepo's untrack + reload.
 */
const GORTEX_ORPHAN_REAP_RSS_MB = 4096

/** Whether a boot-time process (by RSS + command) is an oversized gortex daemon worth reaping. */
export function isOversizedGortexDaemon(rssMb: number, command: string): boolean {
  return /gortex/i.test(command) && rssMb >= GORTEX_ORPHAN_REAP_RSS_MB
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH → gone; EPERM → exists but not signal-able by us (still "alive").
    return isRecord(err) && err['code'] === 'EPERM'
  }
}

function pidRssAndCommand(pid: number): Promise<{ rssMb: number; command: string } | null> {
  return new Promise((resolve_) => {
    execFile('ps', ['-p', String(pid), '-o', 'rss=,command='], (err, stdout) => {
      const match = err ? null : stdout.trim().match(/^(\d+)\s+(.*)$/)
      resolve_(match ? { rssMb: Number(match[1]) / 1024, command: match[2] ?? '' } : null)
    })
  })
}

/**
 * Reap an oversized gortex daemon left over from a previous session, read from
 * its pidfile. Run at the very start of boot — before Copse loads its window and
 * renderer — so a multi-GB zombie's memory is freed while our own footprint is
 * still minimal, instead of the two together exceeding RAM and the OS OOM-killing
 * us mid-boot (the failure this fix targets).
 *
 * Kills the pid directly rather than via `gortex daemon stop`, which performs a
 * slow graceful snapshot while holding all that memory; needs no reachable daemon
 * or configured backend. A healthy, appropriately-sized daemon is left running so
 * its warm index is reused. Best-effort — any failure just leaves the daemon.
 */
export async function reapOversizedGortexDaemon(): Promise<void> {
  // Whole body is best-effort: this runs on the boot path, so any failure
  // (missing pidfile, app not ready, ps unavailable) must leave the daemon and
  // never throw into `whenReady`.
  try {
    const pidFile = join(gortexHomeDir(), '.gortex', 'cache', 'daemon.pid')
    let pid: number
    try {
      pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    } catch {
      return // no pidfile → nothing running from a prior session
    }
    if (!Number.isInteger(pid) || pid <= 1 || !pidIsAlive(pid)) return
    const info = await pidRssAndCommand(pid)
    // The `gortex` command check also guards against pid reuse (the pidfile can
    // outlive the process it named).
    if (!info || !isOversizedGortexDaemon(info.rssMb, info.command)) return
    process.kill(pid, 'SIGTERM')
    // A wedged/oversized daemon may not honor SIGTERM promptly; escalate to
    // SIGKILL so we never leave the memory resident and lose the OOM-killer race.
    for (let i = 0; i < 20; i++) {
      await delay(100)
      if (!pidIsAlive(pid)) return
    }
    process.kill(pid, 'SIGKILL')
  } catch {
    // Best-effort — a leftover daemon is preferable to a failed boot.
  }
}

/**
 * Stop the detached gortex daemon. It is spawned `--detach` (ppid 1) and, without
 * this, outlives Copse — each session it re-tracks/indexes and the orphaned
 * daemons accumulate multi-GB graphs until the machine OOM-kills the app on the
 * next launch. Best-effort and idempotent; called from the app before-quit path.
 */
export async function stopGortexDaemon(): Promise<void> {
  if (activeBackend !== 'gortex' || !gortexCommand) return
  // Signal the daemon directly from its pidfile rather than shelling out to
  // `gortex daemon stop`: the CLI stop waits for a final snapshot, and its
  // subprocess spawn + graceful wait can hold app quit for many seconds —
  // observed as wdio session-DELETE timeouts cascading through an e2e shard
  // (the lingering app also blocks the next launch via the single-instance
  // lock). SIGTERM is immediate; the daemon flushes what it can on its way
  // down, and the index is derived data — rebuilt on next open if needed.
  try {
    const pidFile = join(gortexHomeDir(), '.gortex', 'cache', 'daemon.pid')
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch {
    // No pidfile / daemon already gone / not signal-able — nothing to reap.
  }
  gortexDaemonReady = null
}

async function ensureGortexIndex(workspaceRoot: string): Promise<void> {
  // Scope BEFORE starting the daemon. `untrack` is a plain config edit that works
  // with no daemon running, so this leaves gortex's config listing only the
  // active repo. Ordering matters: a freshly-started daemon reads the *full*
  // config and immediately begins cold-indexing every repo in it — a large
  // previously-opened checkout (e.g. 100k files) balloons to multiple GB and
  // OOM-kills us before a later untrack could drop it. Slimmed first, the daemon
  // (fresh or reused) only ever indexes the active workspace.
  await scopeGortexToActiveRepo(workspaceRoot)
  if (!(await ensureGortexDaemon(workspaceRoot))) {
    throw new Error('gortex daemon failed to start')
  }
  // Register excludes (and shed any pre-exclude index) before track so the very
  // first build already honors them, rather than indexing ~3 GB once first.
  await ensureGortexExcludes(workspaceRoot)
  // --wait blocks until the graph is queryable so the first search after a
  // workspace opens doesn't race a cold index. The command-runner timeout sits
  // a grace margin above gortex's own --wait-timeout so a slow index lets gortex
  // return gracefully (daemon keeps indexing) rather than being SIGKILLed at the
  // exact wait boundary and surfaced as an error (#517).
  await runCommand(
    gortexCmd(),
    ['track', workspaceRoot, '--wait', '--wait-timeout', gortexIndexWaitArg(), '--no-progress'],
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
    hits: await parseGortexJson(stdout, opts.maxResults, opts.filterPath),
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

  return { hits: await parseVeraJson(stdout, opts.maxResults), backend: 'vera' }
}

export async function parseGortexJson(
  stdout: string,
  maxResults: number,
  filterPath?: string,
): Promise<SemanticSearchHit[]> {
  const parsed = parseJsonPayload(stdout)
  const items = extractResultItems(parsed)
  const hits = (await Promise.all(items.map(normalizeGortexHit))).filter(
    (hit): hit is SemanticSearchHit => hit !== null,
  )
  const scoped =
    filterPath && filterPath !== '.'
      ? hits.filter((hit) => hit.path === filterPath || hit.path.startsWith(`${filterPath}/`))
      : hits
  return scoped.slice(0, maxResults)
}

export async function parseVeraJson(
  stdout: string,
  maxResults: number,
): Promise<SemanticSearchHit[]> {
  const parsed = parseJsonPayload(stdout)
  const items = extractResultItems(parsed)
  return (await Promise.all(items.map(normalizeVeraHit)))
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
  if (!isRecord(parsed)) return []

  const record = parsed
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
async function normalizeGortexHit(item: unknown): Promise<SemanticSearchHit | null> {
  if (!isRecord(item)) return null
  const record = item
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
    path: await toRelativePath(path),
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
    text: text.trim(),
    ...(score !== undefined ? { score } : {}),
  }
}

async function normalizeVeraHit(item: unknown): Promise<SemanticSearchHit | null> {
  if (!isRecord(item)) return null
  const record = item
  const path = readString(record, ['path', 'file', 'filename'])
  if (!path) return null

  const startLine = readNumber(record, ['line', 'start_line', 'line_number']) ?? 1
  const endLine = readNumber(record, ['end_line', 'endLine'])
  const text = readString(record, ['snippet', 'content', 'text', 'signature', 'preview']) ?? ''
  const score = readNumber(record, ['score', 'rerank_score', 'relevance'])

  return {
    path: await toRelativePath(path),
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
