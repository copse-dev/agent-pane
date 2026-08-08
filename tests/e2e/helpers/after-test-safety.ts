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

import { execFileSync } from 'node:child_process'

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
    // The socket died mid-request rather than timing out. Observed on the
    // deleteSession half of `reloadSession` (run 31175526565, shard 3), where it
    // was rethrown instead of swallowed — a teardown that fails is not a reason
    // to fail the spec that was about to get a fresh session anyway.
    /UND_ERR_SOCKET/i.test(text) ||
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
 * Bracketed patterns match CI's shard cleanup (`.github/workflows/ci.yml`) and
 * avoid matching the caller's own command line.
 *
 * **ChromeDriver is deliberately absent, and must not be re-added — including
 * as a pid-scoped kill.**
 *
 * WDIO starts the next spec's worker while the previous one is still tearing
 * down. By the time this fires, the driver named by the outgoing session's
 * `wdio:driverPID` is the driver the *incoming* worker has already adopted. So
 * scoping the kill to "our own" pids does not help: the pid is correct and the
 * process is still needed. Killing it by name and killing it by pid land in the
 * same place.
 *
 * Measured, rather than argued (run 31231013554, eight shards, both attempts):
 *
 *   scoped kill (#1615)      0 passed, 21 failed   — every spec, every shard
 *   chromedriver not killed  19-20 passed, 1-2 failed
 *
 * and locally, three specs in one wdio invocation: dead with the kill, all three
 * running without it. Individually they pass either way, so a single-spec check
 * will not show this.
 *
 * Electron is what actually wedges ("Timed out receiving message from
 * renderer"), and killing it alone both frees the session and leaves the driver
 * able to serve the next one. Drivers that genuinely leak are reaped by
 * `cleanup_e2e_processes` in ci.yml, which runs between attempts and on exit —
 * the only moments when nothing is about to need them.
 */
const WEDGED_SESSION_PATTERNS = ['[e]lectron/dist/electron'] as const

/** The kill list, so a test can hold the chromedriver exclusion above. */
export function wedgedSessionPatternsForTest(): readonly string[] {
  return WEDGED_SESSION_PATTERNS
}

/**
 * Best-effort: TERM then KILL a wedged Electron so a subsequent deleteSession
 * fails fast instead of burning connectionRetryTimeout.
 */
export function forceKillWedgedE2eSession(): void {
  for (const signal of ['-TERM', '-KILL'] as const) {
    for (const pattern of WEDGED_SESSION_PATTERNS) {
      try {
        execFileSync('pkill', [signal, '-f', pattern], { stdio: 'ignore' })
      } catch {
        // pkill exits non-zero when nothing matched
      }
    }
  }
}

export type SessionDeleter = {
  deleteSession: (options?: unknown) => Promise<unknown>
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
  const kill = options?.kill ?? forceKillWedgedE2eSession

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
