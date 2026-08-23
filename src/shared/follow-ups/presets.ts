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
  continuePlan: 'continue-plan',
} as const

/**
 * The bubble for a turn that ended with task-plan items still open. It names
 * the first unfinished item so the user can see what "continue" means before
 * sending; the prompt hands the whole remaining plan back to the agent.
 */
export function buildContinuePlanSuggestion(openTodos: string[]): {
  id: string
  label: string
  prompt: string
} {
  const items = openTodos.map((t) => `- ${t}`).join('\n')
  // Destructure rather than index: callers guard on length, but the label must
  // stay a plain string even if one ever slips through with an empty list.
  const [first = ''] = openTodos
  const labelItem = first.replace(/\s+/g, ' ').trim()
  const conciseLabelItem = labelItem.length > 72 ? `${labelItem.slice(0, 71)}…` : labelItem
  return {
    id: DETERMINISTIC_FOLLOW_UP_IDS.continuePlan,
    label: `Continue: ${conciseLabelItem}`,
    prompt:
      'The task plan still has open items. Continue with the next unfinished item, ' +
      'and update the plan as you go:\n' +
      items,
  }
}

/**
 * The changeset chip's content. It still carries a prompt even though callers
 * render it with `action: 'open-changes'` — that is the sentence the bubble sent
 * before the reviewer-pane shortcut existed, kept as the fallback for anything
 * that treats a bubble as a prompt.
 */
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

// When the experimental CI investigator is enabled the suggestion points the
// agent at the `investigate_ci` subagent tool; otherwise it falls back to the
// original generic "Debug CI Failure" prompt so the bubble never references a
// tool that isn't registered.
export function buildDebugCiSuggestion(useInvestigator = false): {
  id: string
  label: string
  prompt: string
} {
  if (useInvestigator) {
    return {
      id: DETERMINISTIC_FOLLOW_UP_IDS.debugCi,
      label: 'Investigate CI failure',
      prompt:
        'The pull request for this branch has failing CI checks. Use the investigate_ci tool to have a subagent read the failing run logs in depth and report the root cause, then fix it.',
    }
  }
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
