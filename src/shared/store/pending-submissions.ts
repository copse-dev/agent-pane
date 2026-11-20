import type { AppStore } from './store.ts'

// Submission starts before an agent run exists. Session state keeps ownership
// through navigation and lets every composer observe external sends ending.

export function beginThreadSubmission(store: AppStore, threadId: string): boolean {
  const pending = store.getState().pendingSubmissionThreadIds
  if (pending.includes(threadId)) return false
  store.setState({ pendingSubmissionThreadIds: [...pending, threadId] })
  return true
}

export function endThreadSubmission(store: AppStore, threadId: string): void {
  const pending = store.getState().pendingSubmissionThreadIds
  if (!pending.includes(threadId)) return
  store.setState({ pendingSubmissionThreadIds: pending.filter((id) => id !== threadId) })
}

export function isThreadSubmitting(store: AppStore, threadId: string): boolean {
  return store.getState().pendingSubmissionThreadIds.includes(threadId)
}
