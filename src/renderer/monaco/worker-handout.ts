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
 *
 * A warm instance nobody claims must not live forever: chat-only windows and
 * pop-outs that never open a diff would otherwise hold an idle worker thread
 * for the window's lifetime. `ttlMs` bounds that — an unclaimed warm instance
 * is dropped after the TTL (and surrendered to `onDiscard` so the caller can
 * terminate it); a `take` after expiry simply boots cold.
 */
export interface WorkerHandout<T> {
  /** Boot (or reuse the still-unclaimed) warm instance for this label. */
  warm(label: string): Promise<T>
  /** Claim the warm instance if one is waiting, else boot a fresh one. */
  take(label: string): Promise<T>
}

export interface WorkerHandoutOptions<T> {
  /**
   * Discard a warm instance that no `take` has claimed after this many
   * milliseconds. Omit to keep warm instances until claimed.
   */
  ttlMs?: number
  /**
   * Receives each discarded instance so the caller can release its resources
   * (for a Worker: terminate it). Never called for claimed or failed boots.
   */
  onDiscard?: (instance: T) => void
}

export function createWorkerHandout<T>(
  create: (label: string) => Promise<T>,
  options: WorkerHandoutOptions<T> = {},
): WorkerHandout<T> {
  const { ttlMs, onDiscard } = options
  const warmed = new Map<string, Promise<T>>()
  const expiries = new Map<string, ReturnType<typeof setTimeout>>()

  function cancelExpiry(label: string): void {
    const timer = expiries.get(label)
    if (timer === undefined) return
    clearTimeout(timer)
    expiries.delete(label)
  }

  function scheduleExpiry(label: string, promise: Promise<T>): void {
    if (ttlMs === undefined) return
    expiries.set(
      label,
      setTimeout(() => {
        expiries.delete(label)
        // The slot may already hold a later boot (this one failed and a retry
        // repopulated it); only ever drop the instance this timer was armed for.
        if (warmed.get(label) !== promise) return
        warmed.delete(label)
        // The boot may still be in flight at expiry: hand the instance over
        // once it exists, and let a failed boot stay dropped silently (its
        // rejection was already surfaced to the `warm` caller).
        promise.then(
          (instance) => onDiscard?.(instance),
          () => undefined,
        )
      }, ttlMs),
    )
  }

  function warm(label: string): Promise<T> {
    const cached = warmed.get(label)
    if (cached) return cached
    const promise = create(label).catch((err: unknown) => {
      // A failed boot must not poison the label: drop it so the next warm or
      // take attempt can retry instead of replaying the same rejection.
      if (warmed.get(label) === promise) {
        warmed.delete(label)
        cancelExpiry(label)
      }
      throw err
    })
    warmed.set(label, promise)
    scheduleExpiry(label, promise)
    return promise
  }

  function take(label: string): Promise<T> {
    const cached = warmed.get(label)
    if (cached) {
      warmed.delete(label)
      cancelExpiry(label)
      return cached
    }
    return create(label)
  }

  return { warm, take }
}
