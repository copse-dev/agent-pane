import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  setThreadComparison,
  setMessageReview,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'
import { markQuietRun } from './quiet-runs.ts'
import type { ComparisonModelSelection } from '../views/approval-comparison-pickers.ts'

// Payload for the standalone review/comparison retries. Mirrors the fields the
// full run sends (see message-queue's refreshPayload) so the retry runs against
// the picker's current model and the thread's persisted goal — read at click
// time so a model swapped in the footer since the failure takes effect.
function retryPayload(
  store: AppStore,
  threadId: string,
  comparisonModels?: ComparisonModelSelection,
): string {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  return JSON.stringify({
    ...(thread?.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
    ...(thread?.model !== undefined ? { model: thread.model } : {}),
    ...(comparisonModels ? { comparisonModels } : {}),
  })
}

/** Payload for the picker's defaults — the thread's model, no run started. */
export function comparisonModelsPayload(store: AppStore, threadId: string): string {
  return retryPayload(store, threadId)
}

/** Re-run the post-turn review for the turn whose review card failed. */
export function retryReview(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  messageId: string,
): void {
  // Flip the card to its running state optimistically so the click has instant
  // feedback; main re-emits the same `running` chunk when it starts. The re-run
  // reviews the current working diff, so its verdict lands on the same message
  // the failed card is anchored to (main's chunk targets that turn's message).
  const projectId = store.getState().activeProjectId
  if (!projectId) return
  setMessageReview(store, threadId, messageId, { status: 'running', summary: '' })
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.retryReview(projectId, threadId, retryPayload(store, threadId))
}

/**
 * Dismiss a failed comparison card without re-running it. Clearing the thread's
 * comparison removes the card on the next sync; autosave persists the removal so
 * the failure doesn't resurface on reload.
 */
export function dismissComparison(store: AppStore, threadId: string): void {
  setThreadComparison(store, threadId, null)
}

/** Re-run the two-model comparison for a thread whose comparison card failed. */
export function retryComparison(store: AppStore, api: ApiClient, threadId: string): void {
  const projectId = store.getState().activeProjectId
  if (!projectId) return
  const thread = store.getState().threads.find((t) => t.id === threadId)
  const comparison = thread?.comparison
  if (comparison) {
    setThreadComparison(store, threadId, { ...comparison, status: 'running' })
  }
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  void api.agent.retryComparison(projectId, threadId, retryPayload(store, threadId))
}

/**
 * Run a comparison the user asked for from the "Compare models" follow-up
 * bubble, with the three models they picked. Unlike {@link retryComparison} this
 * starts a comparison where there was none, so it seeds the running card itself
 * rather than flipping an existing one — main re-emits the same `running` chunk
 * when the run begins, so the click has feedback either way.
 *
 * Marked quiet: the picker's Run button is the user's own action, seconds old,
 * with the card on screen — the completion chime would be noise.
 */
export function startComparison(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  models: ComparisonModelSelection,
): void {
  const projectId = store.getState().activeProjectId
  if (!projectId) return
  setThreadComparison(store, threadId, {
    status: 'running',
    models,
    reviewA: '',
    reviewB: '',
    synthesis: '',
  })
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  markQuietRun(threadId)
  void api.agent.retryComparison(projectId, threadId, retryPayload(store, threadId, models))
}
