import type { GhPrDetails } from '@shared/types/git.ts'

/** Only explicit mergeability results establish a conflict; unknown is neutral. */
export function prHasMergeConflicts(
  pr: Pick<GhPrDetails, 'mergeable' | 'mergeStateStatus'>,
): boolean {
  const status = pr.mergeStateStatus?.toUpperCase()
  return pr.mergeable === 'CONFLICTING' || status === 'DIRTY' || status === 'CONFLICTING'
}
