/**
 * WDIO afterTest hygiene for Electron sessions that wedge mid-spec.
 *
 * When chromedriver loses the renderer ("Timed out receiving message from
 * renderer"), Mocha eventually fires its per-test timeout. The default
 * afterTest then calls `browser.execute` (toast assertion) and optionally
 * screenshot/pageSource against that same dead session — each call burns the
 * CI `connectionRetryTimeout` (30s) before failing, and the following
 * deleteSession burns another 30s. That cascade is what turns one flaky hang
 * into a shard-attempt budget killer (see main tip a73ba769 / e2e shard 8).
 */

/** Mocha's generic "Timeout of Nms exceeded…" error (hooks and tests). */
export function isMochaTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('message' in error)) return false
  const message = error.message
  return typeof message === 'string' && /timeout of \d+ms exceeded/i.test(message)
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
