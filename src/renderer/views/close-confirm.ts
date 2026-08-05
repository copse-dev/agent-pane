import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

/** Titles listed in full before the summary collapses the tail into a count. */
const MAX_LISTED_TITLES = 3

function threadLabel(title: string): string {
  const trimmed = title.trim()
  return trimmed === '' ? 'Untitled thread' : trimmed
}

/**
 * Titles of the threads whose agent is mid-turn — the same `status === 'running'`
 * the sidebar marks with its animated "Agent is working" dots.
 */
export function workingThreadTitles(store: AppStore): string[] {
  return store
    .getState()
    .threads.filter((thread) => thread.status === 'running')
    .map((thread) => threadLabel(thread.title))
}

/** `Fix login, Rename tests and 2 more` — bounded so the dialog can't run away. */
export function summariseWorkingThreads(titles: string[]): string {
  const listed = titles.slice(0, MAX_LISTED_TITLES)
  const remaining = titles.length - listed.length
  if (remaining > 0) return `${listed.join(', ')} and ${String(remaining)} more`
  if (listed.length < 2) return listed.join('')
  return `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1] ?? ''}`
}

/**
 * Decide whether the app may close, prompting only when a thread is still
 * working. Closing tears the agent's session down mid-turn with no resume, so
 * this is the one chance the user gets to keep it alive.
 */
export async function confirmClose(store: AppStore): Promise<boolean> {
  const titles = workingThreadTitles(store)
  if (titles.length === 0) return true

  const one = titles.length === 1
  return await showConfirmDialog({
    message: one
      ? 'Close Copse while the agent is still working?'
      : `Close Copse while ${String(titles.length)} threads are still working?`,
    detail: `${summariseWorkingThreads(titles)} ${one ? 'is' : 'are'} mid-turn. Closing stops the run — anything the agent has not already written to your files is lost.`,
    confirmLabel: 'Close anyway',
    cancelLabel: one ? 'Keep working' : 'Keep them working',
    danger: true,
  })
}

/**
 * Answer main's pre-close question (see `main/services/close-confirm.ts`).
 * Returns an unsubscribe so tests can detach.
 */
export function mountCloseConfirm(api: ApiClient, store: AppStore): () => void {
  return api.closeConfirm.onRequest((req) => {
    void confirmClose(store).then((confirmed) => api.closeConfirm.respond(req.id, confirmed))
  })
}
