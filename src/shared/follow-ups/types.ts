export type FollowUpVariant = 'default' | 'changes'

/**
 * What clicking a bubble does. Every bubble used to send its `prompt`; some now
 * open a surface instead, because dropping a canned sentence into the chat is
 * the wrong answer when the app can just *do* the thing:
 *  - `prompt` (default) — send `prompt` as the next message.
 *  - `open-changes` — open the changeset reviewer pane.
 *  - `model-compare` — open the comparison model picker, then run a comparison
 *    of the working diff with the models chosen there.
 *  - `create-pr` — open the pull-request dialog (title, description, draft),
 *    then open the PR through the same `createPrForThread` path the
 *    `gh_pr_create` tool uses. No prompt is sent and no model runs.
 */
export type FollowUpAction = 'prompt' | 'open-changes' | 'model-compare' | 'create-pr'

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
  /**
   * Contents of the thread's task-plan items still open when the turn ended
   * (pending / in_progress). Absent or empty when the plan was fully reconciled
   * or the thread runs no plan. Drives the deterministic "continue the plan"
   * bubble; the model-picked suggestions see it too.
   */
  openTodos?: string[] | undefined
}

/** IPC/prompt bounds for unfinished plan context. */
export const MAX_FOLLOW_UP_OPEN_TODOS = 20
export const MAX_FOLLOW_UP_OPEN_TODO_CHARS = 500

/**
 * Normalize renderer-owned todo contents before they cross the guarded IPC
 * boundary. The guard remains fail-closed for compromised callers, while valid
 * persisted plans are reduced to the same bounded shape instead of disabling
 * the entire follow-up pipeline.
 */
export function normalizeFollowUpOpenTodos(contents: readonly string[]): string[] {
  const normalized: string[] = []
  for (const content of contents) {
    const item = content.trim().slice(0, MAX_FOLLOW_UP_OPEN_TODO_CHARS)
    if (!item) continue
    normalized.push(item)
    if (normalized.length >= MAX_FOLLOW_UP_OPEN_TODOS) break
  }
  return normalized
}

export interface PrWorkspaceContext {
  branch: string | null
  hasOpenPr: boolean
  hasMergeConflicts: boolean
  hasCiFailures: boolean
  changeStats: { additions: number; deletions: number } | null
  /**
   * True when this branch has work that no pull request carries yet and `gh`
   * could open one: a side branch, no open PR, and something to publish
   * (uncommitted edits or commits the base branch does not have).
   */
  canOpenPr: boolean
}
