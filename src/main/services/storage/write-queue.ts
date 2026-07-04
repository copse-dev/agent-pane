// A keyed serialized write queue. electron-store performs synchronous,
// non-atomic read-modify-write of a single JSON file, so two concurrent async
// callers that each read-then-write the same key can drop one update (the
// classic lost-update race in `rememberMcpTool` / `setMcpServerUserEnabled`).
//
// `runSerialized` chains async write operations per key so they run strictly one
// at a time, in submission order. Different keys run independently. A rejecting
// operation does not poison the chain for later submissions.

const chains = new Map<string, Promise<unknown>>()

export function runSerialized<T>(key: string, op: () => T | Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(
    () => op(),
    () => op(),
  )
  chains.set(key, next)
  // Once this op settles, drop the chain entry if nothing newer was queued, so
  // the map does not grow unbounded across distinct keys.
  void next
    .catch(() => undefined)
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
  return next
}

/** Resolve once every currently-queued write has settled (used on shutdown). */
export async function drainWriteQueue(): Promise<void> {
  // Snapshot to avoid racing with new submissions appended during the await.
  const pending = [...chains.values()]
  await Promise.allSettled(pending)
}
