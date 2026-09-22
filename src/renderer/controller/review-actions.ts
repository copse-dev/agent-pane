import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ReviewFindingRecord } from '@shared/types'
import {
  setReviewFindingDismissed,
  setThreadComparison,
  setThreadReviewReport,
  setMessageReview,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import { syncAgentActivity } from '../agent-activity.ts'
import { markQuietRun, takeQuietRun } from './quiet-runs.ts'
import { showErrorToast } from '../views/toast.ts'
import { errorMessage } from '@copse/std/errors.ts'

// Payload for the standalone review runs and retries. Mirrors the fields the
// full run sends (see message-queue's refreshPayload) so the run happens against
// the picker's current model and the thread's persisted goal — read at click
// time so a model swapped in the footer since the failure takes effect.
function reviewPayload(store: AppStore, threadId: string): string {
  const thread = store.getState().threads.find((t) => t.id === threadId)
  return JSON.stringify({
    ...(thread?.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
    ...(thread?.model !== undefined ? { model: thread.model } : {}),
  })
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
  void api.agent.retryReview(projectId, threadId, reviewPayload(store, threadId))
}

/**
 * Dismiss a retired comparison card without re-running it (nothing can run one
 * any more). Clearing the thread's comparison removes the card on the next
 * sync; autosave persists the removal so it doesn't resurface on reload.
 */
export function dismissComparison(store: AppStore, threadId: string): void {
  setThreadComparison(store, threadId, null)
}

/**
 * Run Copse Reviewer over the thread's changes — the Changes view's "Review"
 * and the "Review changes" follow-up bubble. Seeds the running card itself so
 * the click has feedback before main's own `running` chunk arrives (which then
 * replaces it with the resolved models).
 *
 * Marked quiet: the gesture is the user's own action, seconds old, with the
 * card on screen — the completion chime would be noise.
 */
export function startReview(store: AppStore, api: ApiClient, threadId: string): void {
  const projectId = store.getState().activeProjectId
  if (!projectId) return
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (thread?.status === 'running') return
  setThreadReviewReport(store, threadId, {
    status: 'running',
    startedAt: Date.now(),
    models: { reviewer: thread?.model ?? '', challenger: null },
    lenses: [],
    baseRef: '',
    headCommit: null,
    dirtyWorkingTree: false,
    execution: { backend: '', strength: 'none', executed: false, reason: '' },
    checks: [],
    notChecked: [],
    findings: [],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 0,
  })
  setThreadStatus(store, threadId, 'running')
  syncAgentActivity(store, threadId, false)
  markQuietRun(threadId)
  void api.review.run(projectId, threadId, reviewPayload(store, threadId)).catch((err: unknown) => {
    const report = store.getState().threads.find((t) => t.id === threadId)?.reviewReport
    if (report?.status === 'running') {
      setThreadReviewReport(store, threadId, {
        ...report,
        status: 'error',
        error: errorMessage(err),
        durationMs: Date.now() - report.startedAt,
      })
      setThreadStatus(store, threadId, 'idle')
      syncAgentActivity(store, threadId, false)
      takeQuietRun(threadId)
    }
    showErrorToast('Review could not start', err)
  })
}

/** Remove a review card that failed; a fresh "Review" starts a new run. */
export function dismissReviewReport(store: AppStore, threadId: string): void {
  setThreadReviewReport(store, threadId, null)
}

/**
 * Dismiss one finding: hide it on the card now and persist the dismissal in
 * main's knowledge store so the next review marks it dismissed again (P8).
 * The store flip is optimistic; a failed persist is surfaced and reverted.
 */
export function dismissReviewFinding(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  finding: ReviewFindingRecord,
): void {
  setReviewFindingDismissed(store, threadId, finding.id, true)
  void api.review
    .dismissFinding({
      findingId: finding.id,
      path: finding.path,
      claim: finding.claim,
      class: finding.class,
    })
    .catch((err: unknown) => {
      setReviewFindingDismissed(store, threadId, finding.id, false)
      showErrorToast('Could not save the dismissal', err)
    })
}

/** Undo a dismissal: show the finding again and drop the persisted note. */
export function restoreReviewFinding(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  findingId: string,
): void {
  setReviewFindingDismissed(store, threadId, findingId, false)
  void api.review.restoreFinding(findingId).catch((err: unknown) => {
    setReviewFindingDismissed(store, threadId, findingId, true)
    showErrorToast('Could not restore the finding', err)
  })
}
