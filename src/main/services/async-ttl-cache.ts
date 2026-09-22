/**
 * A bounded cache for asynchronous reads.
 *
 * The cache owns the concurrency details that are easy to get subtly wrong at
 * call sites:
 *
 * - callers for the same key share one in-flight load;
 * - invalidating a key also orphans its in-flight load, so a late response
 *   cannot repopulate the cache;
 * - a forced load supersedes both a cached value and older in-flight work;
 * - TTL starts when the load resolves, rather than when a slow request starts;
 * - settled entries use a small LRU bound so credential- or URL-keyed caches do
 *   not retain every value seen during a long app session.
 *
 * Rejections are never cached. Callers that intentionally want a short-lived
 * failure cache should return a result object and choose its TTL with `ttlMs`.
 */

export type AsyncCacheLookup<Value> =
  | { readonly hit: false }
  | { readonly hit: true; readonly value: Value }

export interface AsyncTtlCacheOptions<Value> {
  /** Fixed TTL, or a per-result TTL (useful for shorter failure caching). */
  readonly ttlMs: number | ((value: Value) => number)
  /** Maximum number of settled values retained. Defaults to 64. */
  readonly maxEntries?: number
  /** Clock seam for deterministic tests. */
  readonly now?: () => number
}

export interface AsyncCacheLoadOptions {
  /** Ignore cached/in-flight work and make this load the new owner for the key. */
  readonly force?: boolean
}

interface CacheEntry<Value> {
  readonly value: Value
  readonly expiresAt: number
}

interface PendingLoad<Value> {
  readonly token: symbol
  readonly promise: Promise<Value>
}

export class AsyncTtlCache<Key, Value> {
  private readonly entries = new Map<Key, CacheEntry<Value>>()
  private readonly pending = new Map<Key, PendingLoad<Value>>()
  private readonly ttlMs: number | ((value: Value) => number)
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: AsyncTtlCacheOptions<Value>) {
    const maxEntries = options.maxEntries ?? 64
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('AsyncTtlCache maxEntries must be a positive integer.')
    }
    this.ttlMs = options.ttlMs
    this.maxEntries = maxEntries
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Return a fresh settled value without starting a load. */
  peek(key: Key): AsyncCacheLookup<Value> {
    const entry = this.freshEntry(key)
    return entry ? { hit: true, value: entry.value } : { hit: false }
  }

  /** Read a fresh value, loading and coalescing when the cache misses. */
  get(key: Key, load: () => Promise<Value>, options: AsyncCacheLoadOptions = {}): Promise<Value> {
    if (options.force === true) {
      this.invalidate(key)
    } else {
      const entry = this.freshEntry(key)
      if (entry) return Promise.resolve(entry.value)
      const active = this.pending.get(key)
      if (active) return active.promise
    }

    const token = Symbol('async-cache-load')
    let loaded: Promise<Value>
    try {
      // Invoke synchronously so a second caller in the same tick can observe
      // that the request has started (and tests do not need a microtask flush).
      loaded = load()
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error))
      return Promise.reject(reason)
    }

    const promise = loaded
      .then((value) => {
        if (this.pending.get(key)?.token === token) this.store(key, value)
        return value
      })
      .finally(() => {
        if (this.pending.get(key)?.token === token) this.pending.delete(key)
      })
    this.pending.set(key, { token, promise })
    return promise
  }

  /** Seed/replace one value and supersede any older in-flight load for its key. */
  set(key: Key, value: Value): void {
    this.pending.delete(key)
    this.store(key, value)
  }

  /** Drop one value and orphan any in-flight load for the same key. */
  invalidate(key: Key): void {
    this.entries.delete(key)
    this.pending.delete(key)
  }

  /** Drop every value and orphan every in-flight load. */
  clear(): void {
    this.entries.clear()
    this.pending.clear()
  }

  /** Settled entry count, exposed for diagnostics and tests. */
  get size(): number {
    return this.entries.size
  }

  private freshEntry(key: Key): CacheEntry<Value> | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    // Map insertion order doubles as a tiny LRU list.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  private store(key: Key, value: Value): void {
    const ttlMs = typeof this.ttlMs === 'function' ? this.ttlMs(value) : this.ttlMs
    if (!(ttlMs > 0)) {
      this.entries.delete(key)
      return
    }
    const expiresAt = ttlMs === Infinity ? Infinity : this.now() + ttlMs
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt })
    while (this.entries.size > this.maxEntries) {
      const iterator = this.entries.keys().next()
      if (iterator.done) break
      this.entries.delete(iterator.value)
    }
  }
}
