/**
 * Consume-once handout of pre-warmed Monaco workers.
 *
 * Monaco owns every Worker its `MonacoEnvironment.getWorker` receives: it
 * terminates the instance when the window has held no text models for a
 * moment, or after five idle minutes, and asks `getWorker` again on the next
 * request. Memoising the instance per label therefore handed Monaco back a
 * worker it had itself already terminated — after which no diff ever computed
 * again in that window, rendering every diff uncoloured while a fresh window
 * (own renderer, own worker) still coloured the same content (#1753).
 *
 * `warm` boots a worker ahead of Monaco's first request and keeps it until
 * `take` hands it over; every `take` after that boots a fresh instance whose
 * lifecycle belongs entirely to Monaco.
 */
export interface WorkerHandout<T> {
  /** Boot (or reuse the still-unclaimed) warm instance for this label. */
  warm(label: string): Promise<T>
  /** Claim the warm instance if one is waiting, else boot a fresh one. */
  take(label: string): Promise<T>
}

export function createWorkerHandout<T>(create: (label: string) => Promise<T>): WorkerHandout<T> {
  const warmed = new Map<string, Promise<T>>()

  function warm(label: string): Promise<T> {
    const cached = warmed.get(label)
    if (cached) return cached
    const promise = create(label).catch((err: unknown) => {
      // A failed boot must not poison the label: drop it so the next warm or
      // take attempt can retry instead of replaying the same rejection.
      if (warmed.get(label) === promise) warmed.delete(label)
      throw err
    })
    warmed.set(label, promise)
    return promise
  }

  function take(label: string): Promise<T> {
    const cached = warmed.get(label)
    if (cached) {
      warmed.delete(label)
      return cached
    }
    return create(label)
  }

  return { warm, take }
}
