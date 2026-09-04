/**
 * Put a ceiling on quit cleanup (issue #1911).
 *
 * `cleanupBeforeQuit` awaits a long chain of other people's shutdowns — ACP
 * sessions, MCP servers, the project sandbox, the gortex daemon, the write
 * queue. Any one of them hanging leaves the app alive with its window gone and
 * no way out but SIGKILL. A deadline converts that from "wedged forever" into
 * "clean if it can be, hard exit if it cannot".
 *
 * Scope, honestly stated: this is defence in depth, not the primary fix. The
 * deadline is a timer, so it needs the event loop to be turning. It rescues a
 * cleanup step that is *waiting* on something that never arrives — the common
 * case — but not a main process that is spinning so hard nothing else gets
 * scheduled. Not being able to spin is the stdio guard's job, not this one's.
 */

export type DeadlineOutcome = 'completed' | 'failed' | 'timed-out'

/**
 * Injectable so tests drive the deadline without sleeping. `schedule` hands back
 * its own canceller rather than a handle, which keeps the platform's timer type
 * (`Timeout` on Node, `number` in a test fake) private to each implementation.
 */
export interface DeadlineTimers {
  schedule: (fn: () => void, ms: number) => () => void
}

const realTimers: DeadlineTimers = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => {
      clearTimeout(handle)
    }
  },
}

export interface DeadlineDeps {
  /** Runs if `work` is still pending at the deadline. */
  onTimeout?: () => void
  /** Runs if `work` rejects. A failed cleanup must not block the quit. */
  onError?: (err: unknown) => void
  timers?: DeadlineTimers
}

/**
 * Run `work`, resolving at the deadline whether or not it has finished.
 *
 * A timed-out `work` is abandoned, not cancelled — there is no way to cancel an
 * arbitrary promise, and the caller's response to `'timed-out'` is expected to
 * be terminal (a hard exit) rather than a retry. Its later settlement is
 * ignored, including a rejection, so an abandoned cleanup cannot raise an
 * unhandled rejection on the way out.
 */
export async function runWithDeadline(
  work: () => Promise<unknown>,
  deadlineMs: number,
  deps: DeadlineDeps = {},
): Promise<DeadlineOutcome> {
  const timers = deps.timers ?? realTimers
  let settled = false

  const attempt = (async (): Promise<DeadlineOutcome> => {
    try {
      await work()
      return 'completed'
    } catch (err) {
      // Swallowed by design: reported through `onError`, then treated as a
      // finished cleanup so the quit proceeds.
      deps.onError?.(err)
      return 'failed'
    }
  })()

  const expiry = new Promise<DeadlineOutcome>((resolve) => {
    const cancel = timers.schedule(() => {
      if (settled) return
      deps.onTimeout?.()
      resolve('timed-out')
    }, deadlineMs)
    void attempt.finally(() => {
      settled = true
      cancel()
    })
  })

  return Promise.race([attempt, expiry])
}
