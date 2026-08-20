export type FollowUpVariant = 'default' | 'changes'

/**
 * What clicking a bubble does. Every bubble used to send its `prompt`; some now
 * open a surface instead, because dropping a canned sentence into the chat is
 * the wrong answer when the app can just *do* the thing:
 *  - `prompt` (default) — send `prompt` as the next message.
 *  - `open-changes` — open the changeset reviewer pane.
 *  - `model-compare` — open the comparison model picker, then run a comparison
 *    of the working diff with the models chosen there.
 */
export type FollowUpAction = 'prompt' | 'open-changes' | 'model-compare'

/** A clickable follow-up bubble shown above the input bar. */
export interface FollowUpSuggestion {
  id: string
  label: string
  /** The message an `action: 'prompt'` bubble sends; absent on action bubbles. */
  prompt?: string
  action?: FollowUpAction
  variant?: FollowUpVariant
  /** Present when variant is "changes" — rendered as green/red counts. */
  additions?: number
  deletions?: number
}

export interface FollowUpContext {
  userMessage: string
  assistantMessage: string
  toolNames: string[]
}

export interface PrWorkspaceContext {
  branch: string | null
  hasOpenPr: boolean
  hasMergeConflicts: boolean
  hasCiFailures: boolean
  changeStats: { additions: number; deletions: number } | null
}
