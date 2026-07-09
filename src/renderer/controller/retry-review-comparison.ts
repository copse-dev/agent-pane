import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  setThreadComparison,
  setThreadReview,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'

// Payload for the standalone review/comparison retries. Mirrors the fields the
// full run sends (see message-queue's refreshPayload) so the retry runs against
// the picker's current model and the thread's persisted goal — read at click
// time so a model swapped in the footer since the failure takes effect.
function retryPayload(store: AppStore, threadId: string): string {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  return JSON.stringify({
    ...(thread?.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
    ...(thread?.model !== undefined ? { model: thread.model } : {}),
  })
}

/** Re-run the post-turn review for a thread whose review card failed. */
export function retryReview(store: AppStore, api: ApiClient, threadId: string): void {
  // Flip the card to its running state optimistically so the click has instant
  // feedback; main re-emits the same `running` chunk when it starts.
  setThreadReview(store, threadId, { status: 'running', summary: '' })
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.retryReview(threadId, retryPayload(store, threadId))
}

/** Re-run the two-model comparison for a thread whose comparison card failed. */
export function retryComparison(store: AppStore, api: ApiClient, threadId: string): void {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const comparison = thread?.comparison
  if (comparison) {
    setThreadComparison(store, threadId, { ...comparison, status: 'running' })
  }
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.retryComparison(threadId, retryPayload(store, threadId))
}
