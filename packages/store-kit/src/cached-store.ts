/**
 * Write-through in-memory cache over a key-value backing store.
 *
 * Exists because electron-store's `.get` re-reads and re-JSON-parses the ENTIRE
 * config.json from disk on every call. Before #993, `llm-history:*` entries
 * grew that file to tens of MB, so any code that called storageGet in a loop
 * (observed: the workspace file-index build resolving the execution target per
 * file, #942) burned minutes of 100% CPU parsing ~21 MB of JSON thousands of
 * times and OOM/hung the editor on startup. The cache remains valuable for
 * other hot-loop reads even after history leaves config.json.
 *
 * Contract (guarded by cached-store.test.ts): backing reads are O(1) per key —
 * once per key per process lifetime, no matter how many times the key is read.
 *
 * Values are cloned on the way in and out to keep electron-store's prior
 * semantics: each read used to return a freshly-parsed object, so callers could
 * mutate their copy without affecting later reads (and mutating a value after
 * `set` must not alter what was persisted).
 */
export interface BackingStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  /** List every key currently in the backing store (migrations / diagnostics). */
  listKeys(): string[]
  /**
   * Delete many keys in a single backing rewrite. Per-key `delete` would
   * re-serialize the whole config once per key (the startup amplification #993
   * removes); callers that finish a bulk migration must use this instead.
   */
  deleteKeys(keys: string[]): void
}

export interface CachedStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  listKeys(): string[]
  deleteKeys(keys: string[]): void
  /** Number of reads that reached the backing store (the O(1)-per-key contract). */
  backingReads(): number
  /** Number of write/delete operations that reached the backing store. */
  backingWrites(): number
}

function cloneValue(value: unknown): unknown {
  // Values are JSON-serializable (they round-trip through the backing store),
  // so structuredClone is safe; undefined passes through as-is.
  return value === undefined ? undefined : structuredClone(value)
}

export function createCachedStore(backing: BackingStore): CachedStore {
  const cache = new Map<string, unknown>()
  let reads = 0
  let writes = 0

  return {
    get(key: string): unknown {
      if (!cache.has(key)) {
        reads += 1
        cache.set(key, backing.get(key))
      }
      return cloneValue(cache.get(key))
    },
    set(key: string, value: unknown): void {
      cache.set(key, cloneValue(value))
      writes += 1
      backing.set(key, value)
    },
    delete(key: string): void {
      cache.delete(key)
      writes += 1
      backing.delete(key)
    },
    listKeys(): string[] {
      return backing.listKeys()
    },
    deleteKeys(keys: string[]): void {
      if (keys.length === 0) return
      for (const key of keys) cache.delete(key)
      writes += 1
      backing.deleteKeys(keys)
    },
    backingReads(): number {
      return reads
    },
    backingWrites(): number {
      return writes
    },
  }
}
