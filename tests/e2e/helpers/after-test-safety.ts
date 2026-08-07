/**
 * WDIO afterTest / session-teardown hygiene for Electron sessions that wedge.
 *
 * When chromedriver loses the renderer ("Timed out receiving message from
 * renderer"), Mocha eventually fires its per-test timeout. The default
 * afterTest then calls `browser.execute` (toast assertion) and optionally
 * screenshot/pageSource against that same dead session — each call burns the
 * CI `connectionRetryTimeout` before failing, and the following deleteSession
 * burns another full budget. That cascade is what turns one flaky hang into a
 * shard-attempt budget killer (see main tip a73ba769 / e2e shard 8,
 * tip dff94ce5 / e2e shard 7, tip cdeb3abf / e2e shard 2).
 *
 * A second failure mode: the suite body passes, afterTest succeeds, then
 * deleteSession hangs and WDIO marks the *file* FAILED (cdeb3abf attempt 3 /
 * git-changes-image). We force-kill wedged Electron/chromedriver and swallow
 * dead deleteSession errors so teardown cannot flip a green suite red.
 */

/** Mocha's generic "Timeout of Nms exceeded…" error (hooks and tests). */
export function isMochaTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('message' in error)) return false
  const message = error.message
  return typeof message === 'string' && /timeout of \d+ms exceeded/i.test(message)
}

/**
 * WebDriver / undici transport death — the session cannot answer further
 * commands usefully. Distinct from a real assertion failure (toasts, DOM).
 */
export function isDeadSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const parts: string[] = []
  if ('message' in error && typeof error.message === 'string') parts.push(error.message)
  if ('name' in error && typeof error.name === 'string') parts.push(error.name)
  if ('code' in error && typeof error.code === 'string') parts.push(error.code)
  const text = parts.join('\n')
  return (
    /UND_ERR_HEADERS_TIMEOUT/i.test(text) ||
    /UND_ERR_CONNECT_TIMEOUT/i.test(text) ||
    /UND_ERR_BODY_TIMEOUT/i.test(text) ||
    /operation was aborted due to timeout/i.test(text) ||
    /timed out receiving message from renderer/i.test(text) ||
    /ECONNRESET|ECONNREFUSED|EPIPE/i.test(text) ||
    /no such session|invalid session id/i.test(text) ||
    /target window already closed|chrome not reachable/i.test(text)
  )
}

/** True when afterTest must not talk to the WebDriver session at all. */
export function shouldSkipAfterTestSessionTraffic(error: unknown): boolean {
  return isMochaTimeoutError(error) || isDeadSessionError(error)
}

/**
 * Race `promise` against `ms`. Rejects with a TimeoutError-shaped Error when
 * the timer wins so callers can treat it like any other failure.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${String(ms)}ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Our afterTest budget timeout (not a real toast / DOM assertion). */
export function isAfterTestBudgetTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('message' in error)) return false
  const message = error.message
  return typeof message === 'string' && /afterTest .+ timed out after \d+ms/i.test(message)
}

/** deleteSession budget timeout from {@link installDeleteSessionSafety}. */
export function isDeleteSessionBudgetTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('message' in error)) return false
  const message = error.message
  return typeof message === 'string' && /deleteSession timed out after \d+ms/i.test(message)
}

/**
 * Errors that must not fail a passing test from afterTest — session is dead or
 * our budget fired. Real toast failures return quickly with
 * "Unexpected error toast(s): …".
 */
export function isIgnorableAfterTestError(error: unknown): boolean {
  return isDeadSessionError(error) || isAfterTestBudgetTimeout(error) || isMochaTimeoutError(error)
}

/** True when session teardown failure must not flip a green suite red. */
export function isIgnorableDeleteSessionError(error: unknown): boolean {
  return (
    isDeadSessionError(error) ||
    isDeleteSessionBudgetTimeout(error) ||
    isAfterTestBudgetTimeout(error)
  )
}

/**
 * TEMPORARY instrumentation for the e2e driver-death investigation (#1615).
 *
 * Scoping the kill did not stop the drivers dying, which ruled the cross-worker
 * cascade out. Two possibilities remain, and one measurement separates them:
 * whether our own kill finds the driver **already dead**.
 *
 *   - alive when we signal it  -> we are killing our own live driver, and the
 *     worker's next reloadSession fails because of us. The bug is the trigger.
 *   - already dead             -> something outside this code killed it first.
 *
 * Gated on COPSE_E2E so unit-test output stays clean. Remove once answered.
 */
const KILL_DEBUG = process.env['COPSE_E2E'] === '1'

function killDebug(message: string): void {
  if (KILL_DEBUG) console.log(`[wedged-kill] ${message}`)
}

/** Signal 0 probes liveness without touching the process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The processes backing one WDIO session: its driver and its Electron. */
export type WedgedSessionPids = {
  /** chromedriver, from WDIO's `wdio:driverPID`. */
  driverPid?: number
  /** Electron's main process, from chromedriver's `goog:processID`. */
  browserPid?: number
}

/**
 * Pull this session's own pids out of its capabilities.
 *
 * Read these at kill time, never cached: `reloadSession` replaces
 * `instance.capabilities` wholesale, so a pid captured at install time belongs
 * to a process that is already gone.
 */
export function sessionPidsFromCapabilities(capabilities: unknown): WedgedSessionPids {
  if (typeof capabilities !== 'object' || capabilities === null) {
    killDebug(`caps unusable: ${typeof capabilities}`)
    return {}
  }
  const caps = capabilities as Record<string, unknown>
  const pids: WedgedSessionPids = {}
  if (isKillablePid(caps['wdio:driverPID'])) pids.driverPid = caps['wdio:driverPID']
  if (isKillablePid(caps['goog:processID'])) pids.browserPid = caps['goog:processID']
  if (pids.driverPid === undefined && pids.browserPid === undefined) {
    // Which key is missing matters: absent means the kill was a silent no-op
    // all along, so the pkill removal cannot explain anything either way.
    killDebug(
      `no pids resolved — raw wdio:driverPID=${String(caps['wdio:driverPID'])} ` +
        `goog:processID=${String(caps['goog:processID'])} keys=${Object.keys(caps).join(',')}`,
    )
  }
  return pids
}

/**
 * A pid we are allowed to signal. Excludes init and our own process, and
 * rejects `0`/negatives outright — `process.kill` reads those as "every process
 * in a group", which is the blast radius this function exists to avoid.
 */
function isKillablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone, or not ours to signal
  }
}

/**
 * Best-effort: TERM then KILL **this session's own** Electron + chromedriver so
 * a subsequent deleteSession fails fast (ECONNREFUSED) instead of burning
 * connectionRetryTimeout.
 *
 * This used to `pkill -f` every `electron-chromedriver/bin/chromedriver` on the
 * host, which is self-defeating inside a shard. WDIO starts the next spec's
 * worker while the previous one tears down, so worker N's kill reaped the
 * driver worker N+1 had just spawned; N+1 then failed with "Unable to connect
 * … make sure browser driver is running", its own afterTest saw a dead session
 * and fired the same global kill at N+2. One genuine wedge cascaded to every
 * remaining spec in the shard — run 31204691492 shows one wedge marker against
 * 21 started-then-killed drivers, 0-2 passed / 19-21 failed on every shard.
 *
 * Passing no pids kills nothing. That is deliberate: if we cannot identify our
 * own processes, doing nothing costs one slow teardown, whereas guessing by
 * name costs every other worker on the host. CI's `cleanup_e2e_processes`
 * (`.github/workflows/ci.yml`) remains the between-jobs sweep for real orphans.
 */
export function forceKillWedgedE2eSession(
  pids: WedgedSessionPids = {},
  reason = 'unspecified',
): void {
  const targets = [pids.browserPid, pids.driverPid].filter(isKillablePid)
  if (KILL_DEBUG) {
    // "ALREADY-DEAD" here is the whole experiment: it means we are not the ones
    // who killed it, and the search moves outside this file.
    const state = targets
      .map((pid) => `${String(pid)}=${isProcessAlive(pid) ? 'alive' : 'ALREADY-DEAD'}`)
      .join(' ')
    killDebug(
      `fire reason=${reason} driver=${String(pids.driverPid ?? 'none')} ` +
        `browser=${String(pids.browserPid ?? 'none')} targets=${String(targets.length)} [${state}]`,
    )
  }
  // TERM everything before escalating, matching the previous ordering.
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of targets) signalPid(pid, signal)
  }
}

export type SessionDeleter = {
  deleteSession: (options?: unknown) => Promise<unknown>
  /**
   * The live session capabilities, when the caller has them. Supplies the pids
   * {@link forceKillWedgedE2eSession} needs to scope its kill; without it the
   * default kill is a no-op rather than a host-wide sweep.
   */
  capabilities?: unknown
  /**
   * WDIO's supported command override. Required when `session` is the
   * `@wdio/globals` Proxy — that Proxy has no `set` trap, so assigning
   * `session.deleteSession = …` only mutates the empty Proxy target and never
   * reaches `Runner.endSession`'s real browser instance (main tip 2686950f /
   * e2e shard 4: green-body suites still FAILED on DELETE ECONNREFUSED).
   */
  overwriteCommand?: (
    name: string,
    // WDIO binds `this` to the real browser; keep it untyped so unit fakes stay simple.
    fn: (
      this: unknown,
      origCommand: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => unknown,
  ) => void
}

const deleteSessionPatched = new WeakSet<object>()

/** Cap how long deleteSession may block a worker before we kill + swallow. */
export const DELETE_SESSION_BUDGET_MS = 5_000

/**
 * Wrap `session.deleteSession` so a wedged Chromedriver teardown cannot mark a
 * passing suite FAILED. On timeout / transport death: force-kill orphans and
 * return. Real deleteSession success is unchanged.
 *
 * Prefer {@link SessionDeleter.overwriteCommand} when present (live WDIO
 * browser / `@wdio/globals` Proxy). Fall back to own-property assignment for
 * plain unit-test fakes.
 */
export function installDeleteSessionSafety(
  session: SessionDeleter,
  options?: {
    budgetMs?: number
    kill?: () => void
  },
): void {
  if (deleteSessionPatched.has(session)) return
  deleteSessionPatched.add(session)

  const budgetMs = options?.budgetMs ?? DELETE_SESSION_BUDGET_MS
  // Resolve capabilities on each call, not here: reloadSession swaps them out,
  // so an install-time snapshot names a process that has already exited.
  const kill =
    options?.kill ??
    ((): void => {
      forceKillWedgedE2eSession(sessionPidsFromCapabilities(session.capabilities), 'delete-session')
    })

  const runSafeDelete = async (invoke: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await withTimeout(invoke(), budgetMs, 'deleteSession')
    } catch (error) {
      kill()
      if (isIgnorableDeleteSessionError(error)) return undefined
      throw error
    }
  }

  if (typeof session.overwriteCommand === 'function') {
    session.overwriteCommand(
      'deleteSession',
      async function overwriteDeleteSession(
        this: unknown,
        origDeleteSession: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) {
        return await runSafeDelete(async () => await origDeleteSession.apply(this, args))
      },
    )
    return
  }

  const original = session.deleteSession.bind(session)
  session.deleteSession = async (deleteOptions?: unknown) =>
    await runSafeDelete(async () => await original(deleteOptions))
}
