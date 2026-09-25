import type { AppStore } from '@shared/store/store.ts'
import type { ThreadReviewReport } from '@shared/types'
import {
  getThreadById,
  setMessageReviewReport,
  setThreadReviewReport,
} from '@shared/store/thread-helpers.ts'

// Standalone reviews stream over the same thread channel as agent turns, but
// their chunks do not carry a message id. Keep the target beside the renderer
// store for the lifetime of the run so a stale persisted `running` card cannot
// capture a later review. A null target intentionally means the legacy
// thread-level slot (threads with no assistant message yet).
const targetsByStore = new WeakMap<AppStore, Map<string, string | null>>()

export function setReviewReportTarget(
  store: AppStore,
  threadId: string,
  messageId: string | null,
): void {
  const targets = targetsByStore.get(store) ?? new Map<string, string | null>()
  targets.set(threadId, messageId)
  targetsByStore.set(store, targets)
}

export function getReviewReportTarget(
  store: AppStore,
  threadId: string,
): string | null | undefined {
  return targetsByStore.get(store)?.get(threadId)
}

export function clearReviewReportTarget(store: AppStore, threadId: string): void {
  const targets = targetsByStore.get(store)
  if (!targets) return
  targets.delete(threadId)
  if (targets.size === 0) targetsByStore.delete(store)
}

/** The report in a review target's slot: the anchored message's, or the thread-level one. */
export function reviewReportAt(
  store: AppStore,
  threadId: string,
  messageId: string | null,
): ThreadReviewReport | undefined {
  const thread = getThreadById(store, threadId)
  if (messageId === null) return thread?.reviewReport
  return thread?.messages.find((message) => message.id === messageId)?.reviewReport
}

/**
 * Settle a review card that is still `running` in the given slot as an error.
 * Returns whether a card was settled. Used when a run ends (or fails to start)
 * without delivering its final report, so the card cannot spin forever.
 */
export function failRunningReviewReport(
  store: AppStore,
  threadId: string,
  messageId: string | null,
  error: string,
): boolean {
  const report = reviewReportAt(store, threadId, messageId)
  if (report?.status !== 'running') return false
  const failed: ThreadReviewReport = {
    ...report,
    status: 'error',
    error,
    durationMs: Date.now() - report.startedAt,
  }
  if (messageId === null) setThreadReviewReport(store, threadId, failed)
  else setMessageReviewReport(store, threadId, messageId, failed)
  return true
}
