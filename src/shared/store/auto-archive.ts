import type { PrLifecycleState } from '@shared/git/thread-pr-status.ts'

/** Whole days → ms. The setting is stored in days; the rule works in ms. */
export const DAY_MS = 86_400_000

/**
 * What the sweep must know about one thread before it may hide it. Every field
 * is a reason archiving could lose or bury something, so an unknown answer is
 * expressed as the unsafe value (`null` / `'unknown'`), never as a default.
 */
export interface AutoArchiveCandidate {
  id: string
  /** Lifecycle of each PR linked to the thread; empty when it has none. */
  prStates: readonly PrLifecycleState[]
  /** Latest of the thread's own activity and its PR's last update (ms epoch). */
  lastActivityAt: number
  running: boolean
  active: boolean
  /** Unread, awaiting approval, or holding a queued message. */
  needsAttention: boolean
  /** Proposed diffs the user has not accepted or rejected. */
  pendingStagedDiffs: number | null
  /** Uncommitted/untracked/ignored files in the thread's checkout; null = unknown. */
  changedFiles: number | null
  /** Commits the upstream lacks; null when there is no upstream or it is unknown. */
  unpushedCommits: number | null
  archivedAt?: number
}

/**
 * Threads whose work has demonstrably landed and that nothing is waiting on.
 *
 * Deliberately conservative: a thread with no PR, an open or closed-unmerged
 * PR, any local state, or any unknown answer is left alone. Archiving is a
 * soft-hide, but the point of the rule is that the user never has to undo it.
 */
export function selectAutoArchivable(
  candidates: readonly AutoArchiveCandidate[],
  options: { now: number; afterMs: number },
): string[] {
  if (!(options.afterMs > 0)) return []
  return candidates.filter((c) => isAutoArchivable(c, options)).map((c) => c.id)
}

function isAutoArchivable(
  c: AutoArchiveCandidate,
  { now, afterMs }: { now: number; afterMs: number },
): boolean {
  if (c.archivedAt != null || c.running || c.active || c.needsAttention) return false
  if (c.prStates.length === 0 || c.prStates.some((state) => state !== 'merged')) return false
  if (c.pendingStagedDiffs !== 0 || c.changedFiles !== 0 || c.unpushedCommits !== 0) return false
  return now - c.lastActivityAt >= afterMs
}
