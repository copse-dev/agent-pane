import type { FollowUpSuggestion } from './types.ts'
import { buildChangesSuggestion, DETERMINISTIC_FOLLOW_UP_IDS } from './presets.ts'

const DEFAULT_MAX_SUGGESTIONS = 3

function isChangesBubble(s: FollowUpSuggestion): boolean {
  return s.id === DETERMINISTIC_FOLLOW_UP_IDS.changes
}

/**
 * Reconcile the live "Changes" chip into an existing follow-up list.
 *
 * The deterministic Changes bubble is computed once when a turn ends, but the
 * working tree keeps moving after that (edits, commits, accept/reject of
 * proposed diffs), so its +/- counts drift. Given fresh stats this returns an
 * updated list: the chip is inserted, its counts refreshed, or it is dropped
 * when the tree is clean again.
 *
 * Returns the SAME array reference when nothing changed, so callers can cheaply
 * skip a re-render.
 */
export function reconcileChangesSuggestion(
  suggestions: FollowUpSuggestion[],
  stats: { additions: number; deletions: number } | null,
  maxSuggestions: number = DEFAULT_MAX_SUGGESTIONS,
): FollowUpSuggestion[] {
  const existingIndex = suggestions.findIndex(isChangesBubble)

  if (!stats) {
    if (existingIndex === -1) return suggestions
    return suggestions.filter((s) => !isChangesBubble(s))
  }

  const built = buildChangesSuggestion(stats)
  const chip: FollowUpSuggestion = {
    id: built.id,
    label: built.label,
    prompt: built.prompt,
    variant: 'changes',
    additions: built.additions,
    deletions: built.deletions,
  }

  if (existingIndex !== -1) {
    const current = suggestions[existingIndex]
    if (current && current.additions === chip.additions && current.deletions === chip.deletions) {
      return suggestions
    }
    const next = suggestions.slice()
    next[existingIndex] = chip
    return next
  }

  // Deterministic signals lead the list (mirrors follow-up-service ordering).
  return [chip, ...suggestions].slice(0, maxSuggestions)
}
