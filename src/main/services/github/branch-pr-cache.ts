import type { GitOpenPr } from '@shared/types/git.ts'
import { AsyncTtlCache } from '../async-ttl-cache.ts'

export type BranchPrResult = { ok: boolean; pr: GitOpenPr | null }

/**
 * Session-only GitHub observations; local branch reads never use this cache.
 * The SQLite thread index is a projection of thread files, not a remote-read
 * cache. Short-lived observations and in-flight ownership belong in memory,
 * shared by every window through the main process, with no persisted failures.
 */
export class BranchPrCache {
  private readonly cache: AsyncTtlCache<string, BranchPrResult>

  constructor(now: () => number = Date.now) {
    this.cache = new AsyncTtlCache({
      // No-PR is a successful observation too. Authentication/network errors
      // get a longer retry delay; explicit refresh can bypass either lifetime.
      ttlMs: (result): number => (result.ok ? 60_000 : 300_000),
      maxEntries: 256,
      now,
    })
  }

  async get(key: string, load: () => Promise<BranchPrResult>): Promise<GitOpenPr | null> {
    const result = await this.cache.get(key, async () => {
      try {
        return await load()
      } catch {
        // Spawn/network failures need the same backoff as nonzero gh exits.
        return { ok: false, pr: null }
      }
    })
    return result.pr
  }

  invalidate(key?: string): void {
    if (key === undefined) this.cache.clear()
    else this.cache.invalidate(key)
  }
}

export const branchPrCache = new BranchPrCache()
