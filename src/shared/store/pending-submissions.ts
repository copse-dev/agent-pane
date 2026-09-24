import type { AppStore } from './store.ts'

// Submission starts before an agent run exists. Keep ownership outside the
// visible composer so thread/project navigation cannot cancel it or reuse it.
const pendingByStore = new WeakMap<AppStore, Set<string>>()

export function beginThreadSubmission(store: AppStore, threadId: string): boolean {
  let pending = pendingByStore.get(store)
  if (!pending) {
    pending = new Set()
    pendingByStore.set(store, pending)
  }
  if (pending.has(threadId)) return false
  pending.add(threadId)
  return true
}

export function endThreadSubmission(store: AppStore, threadId: string): void {
  pendingByStore.get(store)?.delete(threadId)
}

export function isThreadSubmitting(store: AppStore, threadId: string): boolean {
  return pendingByStore.get(store)?.has(threadId) ?? false
}
