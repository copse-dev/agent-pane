/**
 * A review the user started, as the thread's model history sees it (#2519).
 *
 * When the model calls `review_changes` itself, the report comes back as the
 * tool result and lands in history with the rest of the turn. The Review
 * button and the "Review changes" bubble run the same pipeline outside the
 * dispatcher, so without this the card sat in the transcript and the model
 * answered the next message as if no review had happened.
 *
 * A settled report is written as one exchange: a user line naming the gesture
 * and the report as the assistant's reply. Plain text rather than a synthetic
 * tool call, so an ACP agent's text replay carries it too, and the history
 * still ends on an assistant message before the next user turn. Like
 * `recordContainerRunTurn`, an empty sidecar is rebuilt from the
 * transcript first, because saving only this exchange would stop the
 * dispatcher recovering everything before it.
 */
import type { LLMMessage, Thread } from '@shared/types'
import { rebuildAgentHistory } from '../thread-fork.ts'
import type { ReviewRunResult } from './review-service.ts'

export interface ReviewHistoryDeps {
  loadHistory: (projectId: string, threadId: string) => Promise<LLMMessage[]>
  saveHistory: (projectId: string, threadId: string, messages: LLMMessage[]) => Promise<void>
  loadThread: (projectId: string, threadId: string) => Promise<Thread | null>
  /** Drop the dispatcher's in-memory copy, so the next turn reads the sidecar. */
  forgetHistory: (projectId: string, threadId: string) => void
}

export const USER_REVIEW_PROMPT =
  'I ran Copse Reviewer over this thread’s changes from the Review button.'

/** The exchange a settled review adds; null for a run with nothing to tell the model. */
export function reviewExchange(result: ReviewRunResult): LLMMessage[] | null {
  // An error card (turned off, declined, cancelled, failed) is the user's to
  // act on, not a finding about the code.
  if (result.report.status !== 'done') return null
  const summary = result.summary.trim()
  if (!summary) return null
  return [
    { role: 'user', content: USER_REVIEW_PROMPT },
    { role: 'assistant', content: `Copse Reviewer report:\n\n${summary}` },
  ]
}

/**
 * Write a user-started review into the thread's model history. Returns the
 * history written, for tests; never throws, since a history that cannot be
 * written is not a reason to fail the review the user is looking at.
 */
export async function recordUserReview(
  projectId: string,
  threadId: string,
  result: ReviewRunResult,
  deps: ReviewHistoryDeps,
): Promise<LLMMessage[] | null> {
  const exchange = reviewExchange(result)
  if (!exchange) return null
  try {
    const existing = await deps.loadHistory(projectId, threadId)
    const prior =
      existing.length > 0
        ? existing
        : rebuildAgentHistory((await deps.loadThread(projectId, threadId))?.messages ?? [])
    const history = [...prior, ...exchange]
    await deps.saveHistory(projectId, threadId, history)
    deps.forgetHistory(projectId, threadId)
    return history
  } catch (error) {
    console.warn('[review] could not record the review in the thread history:', error)
    return null
  }
}
