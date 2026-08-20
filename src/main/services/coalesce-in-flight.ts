/**
 * Share a single in-flight run per key.
 *
 * A caller that arrives while a run for its key is still pending joins that run
 * instead of starting its own; once the run settles the key is released, so the
 * next caller always gets fresh work. That makes this a duplicate-suppressor,
 * not a cache — it never serves a stale result, which is what lets it sit in
 * front of live queries (an open-PR lookup, a network probe) that must stay
 * current.
 *
 * The pattern earns its keep where independent views ask the same question in
 * the same tick: the renderer's store emits are synchronous, so several
 * subscribers can each fire the same IPC before any of them resolves.
 */
export function createInFlightCoalescer<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<T>>()
  return (key, run) => {
    const existing = pending.get(key)
    if (existing) return existing
    const started = run().finally(() => {
      // Only clear our own entry: a run started after this one settled owns the
      // key now, and dropping it would leak the coalescing for that caller.
      if (pending.get(key) === started) pending.delete(key)
    })
    pending.set(key, started)
    return started
  }
}
