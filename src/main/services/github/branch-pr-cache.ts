import type { GitOpenPr } from '@shared/types/git.ts'
import { AsyncTtlCache } from '../async-ttl-cache.ts'

export type BranchPrResult<Pr = GitOpenPr> = { ok: boolean; pr: Pr | null }

/**
 * Session-only GitHub observations; local branch reads never use this cache.
 * The SQLite thread index is a projection of thread files, not a remote-read
 * cache. Short-lived observations and in-flight ownership belong in memory,
 * shared by every window through the main process, with no persisted failures.
 */
export class BranchPrCache<Pr = GitOpenPr> {
  private readonly cache: AsyncTtlCache<string, BranchPrResult<Pr>>

  constructor(now: () => number = Date.now) {
    this.cache = new AsyncTtlCache({
      // No-PR is a successful observation too. Authentication/network errors
      // get a longer retry delay; explicit refresh can bypass either lifetime.
      ttlMs: (result): number => (result.ok ? 60_000 : 300_000),
      maxEntries: 256,
      now,
    })
  }

  async get(key: string, load: () => Promise<BranchPrResult<Pr>>): Promise<Pr | null> {
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

/** Each branch's open PR, shared by the footer and the Changes panel. */
export const branchPrCache = new BranchPrCache()

/**
 * Each branch's merged PR head, for the Changes panel's committed base. Kept
 * apart from {@link branchPrCache} because the two answer different questions
 * about the same branch key.
 */
export const branchMergedPrCache = new BranchPrCache<{ sha: string; label: string }>()

/** Drop both branch observations, so a refresh or PR write is read live. */
export function invalidateBranchPrCaches(): void {
  branchPrCache.invalidate()
  branchMergedPrCache.invalidate()
}
