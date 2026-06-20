/** Canned follow-ups the small local model may pick from. Keep this list short. */
export interface FollowUpPreset {
  id: string
  label: string
  prompt: string
}

export const MODEL_FOLLOW_UP_PRESETS: FollowUpPreset[] = [
  {
    id: 'explain',
    label: 'Explain what you changed',
    prompt: 'Summarize the changes you just made and why.',
  },
  {
    id: 'run-tests',
    label: 'Run the tests',
    prompt: 'Run the relevant tests for these changes and fix any failures.',
  },
  {
    id: 'continue',
    label: 'Keep going',
    prompt: 'Continue with the next logical step.',
  },
]

export const DETERMINISTIC_FOLLOW_UP_IDS = {
  changes: 'changes',
  debugCi: 'debug-ci',
  fixMergeConflicts: 'fix-merge-conflicts',
} as const

export function buildChangesSuggestion(stats: { additions: number; deletions: number }): {
  id: string
  label: string
  prompt: string
  additions: number
  deletions: number
} {
  return {
    id: DETERMINISTIC_FOLLOW_UP_IDS.changes,
    label: 'Changes',
    prompt:
      'Review the uncommitted changes in this workspace and suggest any fixes or improvements.',
    additions: stats.additions,
    deletions: stats.deletions,
  }
}

export function buildDebugCiSuggestion(): { id: string; label: string; prompt: string } {
  return {
    id: DETERMINISTIC_FOLLOW_UP_IDS.debugCi,
    label: 'Debug CI Failure',
    prompt:
      'The pull request for this branch has failing CI checks. Investigate the failures and fix them.',
  }
}

export function buildFixMergeConflictsSuggestion(): { id: string; label: string; prompt: string } {
  return {
    id: DETERMINISTIC_FOLLOW_UP_IDS.fixMergeConflicts,
    label: 'Fix merge conflicts',
    prompt: 'This branch has merge conflicts. Resolve them and ensure the branch merges cleanly.',
  }
}
