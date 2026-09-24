import type { AppStore } from '@shared/store/store.ts'

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
