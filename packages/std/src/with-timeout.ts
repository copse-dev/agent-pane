/**
 * Settle with `promise`, or with whatever `onTimeout` produces if `ms` passes
 * first. `onTimeout` runs on the timer: return a fallback (or a sentinel such
 * as `'timeout'`) to resolve with it, or throw to reject with that error (a
 * thrown non-`Error` is wrapped in one, with the value as its `cause`).
 *
 * The timer settles the returned promise directly, in the same turn as
 * `onTimeout`, while `promise`'s outcome arrives through a reaction a microtask
 * later. So when `onTimeout` aborts the work and that work settles on the abort,
 * the timeout's outcome still wins.
 *
 * The timer is cleared as soon as `promise` settles, including when it rejects,
 * so a fast or failing operation never leaves a pending timer that holds the
 * event loop open. The losing promise is not cancelled: a caller that must stop
 * the work does so in `onTimeout`. A rejection from an abandoned `promise` after
 * the timeout is still handled, so it is never reported as unhandled.
 * Environment neutral (main, renderer and packages).
 */
export function withTimeout<T, const U = never>(
  promise: PromiseLike<T>,
  ms: number,
  onTimeout: () => U | PromiseLike<U>,
): Promise<T | U> {
  return new Promise<T | U>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(onTimeout())
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      }
    }, ms)
    const settled = Promise.resolve(promise)
    settled.then(resolve, reject)
    settled.then(
      () => {
        clearTimeout(timer)
      },
      () => {
        clearTimeout(timer)
      },
    )
  })
}
