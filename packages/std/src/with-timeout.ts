/**
 * Settle with `promise`, or with whatever `onTimeout` produces if `ms` passes
 * first. `onTimeout` runs on the timer: return a fallback (or a sentinel such
 * as `'timeout'`) to resolve with it, or throw to reject with that error.
 *
 * The timer is cleared as soon as the race settles, including when `promise`
 * rejects, so a fast or failing operation never leaves a pending timer that
 * holds the event loop open. The losing promise is not cancelled: a caller that
 * must stop the work does so in `onTimeout`. A rejection from an abandoned
 * `promise` after the timeout is observed by the race, so it is never reported
 * as unhandled. Environment neutral (main, renderer and packages).
 */
export function withTimeout<T, const U = never>(
  promise: PromiseLike<T>,
  ms: number,
  onTimeout: () => U | PromiseLike<U>,
): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<U>((resolve) => {
    timer = setTimeout(() => {
      // `onTimeout` runs synchronously on the timer, so its side effects (an
      // abort, a teardown) land before anything else can settle the race. A
      // throw rejects the inner executor's promise, which `resolve` adopts, so
      // callers keep their own error types and messages.
      resolve(
        new Promise<U>((run) => {
          run(onTimeout())
        }),
      )
    }, ms)
  })
  return Promise.race([promise, expired]).finally(() => {
    clearTimeout(timer)
  })
}
