/**
 * Per-key serial execution. `run(key, op)` starts `op` only after every earlier
 * op submitted for the same key has settled, so ops on one key run strictly one
 * at a time in submission order, while different keys run independently.
 *
 * A rejecting op does not poison the chain: the next op for that key still
 * runs, and only the caller of the failed op sees the rejection. `op` always
 * starts asynchronously, even when the key is idle. A key's entry is dropped
 * once its last op settles, so the queue does not grow across distinct keys.
 *
 * Keys compare by identity (`Map` semantics), so an object key such as a
 * WebContents works; it is held only while it has ops in flight.
 */
export interface KeyedSerialQueue<K> {
  run<T>(key: K, op: () => T | Promise<T>): Promise<T>
  /** Resolve once every queued op, including ops they enqueue, has settled. */
  drain(): Promise<void>
}

export function createKeyedSerialQueue<K>(): KeyedSerialQueue<K> {
  const chains = new Map<K, Promise<unknown>>()
  return {
    run<T>(key: K, op: () => T | Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve()
      const next = prev.then(
        () => op(),
        () => op(),
      )
      chains.set(key, next)
      void next
        .catch(() => undefined)
        .finally(() => {
          if (chains.get(key) === next) chains.delete(key)
        })
      return next
    },
    async drain(): Promise<void> {
      // A settling op can enqueue follow-up work. Awaiting one snapshot would
      // return while that newer tail was still in flight, so keep draining
      // until no key points at a promise newer than the snapshot just settled.
      for (;;) {
        const pending = [...chains.values()]
        if (pending.length === 0) return
        await Promise.allSettled(pending)
        if ([...chains.values()].every((chain) => pending.includes(chain))) return
      }
    },
  }
}
