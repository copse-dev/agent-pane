/**
 * A tiny dependency-free LRU cache for string values, bounded by both entry
 * count and total byte size.
 *
 * Motivation: the remote-agent artifact-image cache stores base64 data URLs
 * that can each be tens of MB. An unbounded `Map` slowly leaks memory over long
 * sessions, and capping by entry count alone would not meaningfully bound memory
 * when a few large images can dominate. This cache therefore evicts the
 * least-recently-used entries until it is within BOTH the entry-count and the
 * total-byte budget.
 *
 * A `Map` preserves insertion order, so the first key returned by `keys()` is
 * always the least-recently-used entry. `get` re-inserts the key to mark it as
 * most-recently-used, and `set` evicts from the front until within budget.
 *
 * Note: a single value larger than `maxBytes` is still stored (all other
 * entries are evicted first). This keeps cache-hit behaviour identical for the
 * value that was just written, while still bounding the steady-state footprint.
 */
export class LruStringCache {
  private readonly map = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private totalBytes = 0

  constructor(maxEntries: number, maxBytes: number) {
    if (maxEntries <= 0) throw new Error('LruStringCache maxEntries must be > 0')
    if (maxBytes <= 0) throw new Error('LruStringCache maxBytes must be > 0')
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  /** Byte size of a string value, matching how it is stored in memory. */
  private static sizeOf(value: string): number {
    return Buffer.byteLength(value, 'utf8')
  }

  get(key: string): string | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Mark as most-recently-used by re-inserting at the end.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: string): void {
    const existing = this.map.get(key)
    if (existing !== undefined) {
      this.totalBytes -= LruStringCache.sizeOf(existing)
      this.map.delete(key)
    }
    this.map.set(key, value)
    this.totalBytes += LruStringCache.sizeOf(value)
    this.evict()
  }

  /** Number of entries currently cached. Exposed for tests/introspection. */
  get size(): number {
    return this.map.size
  }

  /** Total bytes currently cached. Exposed for tests/introspection. */
  get bytes(): number {
    return this.totalBytes
  }

  private evict(): void {
    while (
      this.map.size > 1 &&
      (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes)
    ) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      const oldestValue = this.map.get(oldestKey)
      if (oldestValue !== undefined) this.totalBytes -= LruStringCache.sizeOf(oldestValue)
      this.map.delete(oldestKey)
    }
  }
}
