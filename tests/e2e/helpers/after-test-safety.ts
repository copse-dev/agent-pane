/**
 * WDIO afterTest hygiene for Electron sessions that wedge mid-spec.
 *
 * When chromedriver loses the renderer ("Timed out receiving message from
 * renderer"), Mocha eventually fires its per-test timeout. The default
 * afterTest then calls `browser.execute` (toast assertion) and optionally
 * screenshot/pageSource against that same dead session — each call burns the
 * CI `connectionRetryTimeout` (30s) before failing, and the following
 * deleteSession burns another 30s. That cascade is what turns one flaky hang
 * into a shard-attempt budget killer (see main tip a73ba769 / e2e shard 8,
 * tip dff94ce5 / e2e shard 7).
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

/**
 * Errors that must not fail a passing test from afterTest — session is dead or
 * our budget fired. Real toast failures return quickly with
 * "Unexpected error toast(s): …".
 */
export function isIgnorableAfterTestError(error: unknown): boolean {
  return (
    isDeadSessionError(error) || isAfterTestBudgetTimeout(error) || isMochaTimeoutError(error)
  )
}
