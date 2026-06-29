import type { ActiveDiff, StagedDiffEntry } from '@shared/types/state.ts'

export function pruneStagedDiffCache(
  cache: Map<string, ActiveDiff>,
  entries: StagedDiffEntry[],
): void {
  const paths = new Set(entries.map((e) => e.path))
  for (const key of cache.keys()) {
    if (!paths.has(key)) cache.delete(key)
  }
}

/**
 * Decide whether a freshly proposed diff should be jumped to. A proposal the
 * agent just made is the file it is now waiting on, so it takes priority over a
 * stale-but-still-valid current selection (#484). The target is only honored
 * once it is actually queued — `agent:show_diff` arrives before the `diff:queued`
 * broadcast that adds the path — so callers keep it pending until then.
 */
export function shouldJumpToProposed(
  pendingProposedPath: string | null,
  entries: StagedDiffEntry[],
): boolean {
  if (!pendingProposedPath) return false
  return entries.some((e) => e.path === pendingProposedPath)
}

export function resolveStagedDiffView(
  entries: StagedDiffEntry[],
  cache: Map<string, ActiveDiff>,
  selectedPath: string | null,
  activeDiff: ActiveDiff | null,
): ActiveDiff | null {
  if (selectedPath) return cache.get(selectedPath) ?? null
  if (activeDiff && entries.some((e) => e.path === activeDiff.path)) return activeDiff
  const first = entries[0]
  if (first) return cache.get(first.path) ?? null
  return activeDiff
}
