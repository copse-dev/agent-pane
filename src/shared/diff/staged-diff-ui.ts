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
