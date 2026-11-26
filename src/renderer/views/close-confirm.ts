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

/** Titles of the threads main says have a container run going. */
export function containerRunTitles(store: AppStore, threadIds: readonly string[]): string[] {
  const threads = store.getState().threads
  return threadIds.map((id) => threadLabel(threads.find((thread) => thread.id === id)?.title ?? ''))
}

/**
 * What closing does to container runs: they carry on outside Copse with the
 * hand-off on, and stop with it off.
 */
function containerRunSentence(titles: string[], continuesAfterQuit: boolean): string {
  const one = titles.length === 1
  const going = `${summariseWorkingThreads(titles)} ${one ? 'has a container run' : 'have container runs'} going.`
  return continuesAfterQuit
    ? `${going} ${one ? 'It keeps' : 'They keep'} going outside Copse, and you can stop ${one ? 'it' : 'them'} from Copse when you open it again.`
    : `${going} Closing stops ${one ? 'it' : 'them'}.`
}

/**
 * Decide whether the app may close, prompting only when a thread is still
 * working or a container run is going. Closing tears the agent's session down
 * mid-turn with no resume, so this is the one chance the user gets to keep it
 * alive.
 */
export async function confirmClose(
  store: AppStore,
  options: { continuesAfterQuit?: boolean; containerRunThreads?: readonly string[] } = {},
): Promise<boolean> {
  const titles = workingThreadTitles(store)
  const runs = containerRunTitles(store, options.containerRunThreads ?? [])
  const continues = options.continuesAfterQuit === true
  if (titles.length === 0 && runs.length === 0) return true

  if (titles.length === 0) {
    const one = runs.length === 1
    return await showConfirmDialog({
      message: one
        ? 'Close Copse while a container run is going?'
        : `Close Copse while ${String(runs.length)} container runs are going?`,
      detail: containerRunSentence(runs, continues),
      ...(continues
        ? { confirmLabel: 'Close', cancelLabel: 'Keep Copse open' }
        : { confirmLabel: 'Close anyway', cancelLabel: 'Keep Copse open', danger: true }),
    })
  }

  const one = titles.length === 1
  const working = `${summariseWorkingThreads(titles)} ${one ? 'is' : 'are'} mid-turn.`
  const containers = runs.length > 0 ? ` ${containerRunSentence(runs, continues)}` : ''
  // With the hand-off on, the turns carry on in the background and are back
  // when Copse opens again (docs/plans/local-turn-worker.md).
  if (continues) {
    return await showConfirmDialog({
      message: one
        ? 'Close Copse while the agent is still working?'
        : `Close Copse while ${String(titles.length)} threads are still working?`,
      detail: `${working} ${one ? 'It keeps' : 'They keep'} going in the background after Copse closes, and ${one ? 'is' : 'are'} here when you open it again.${containers}`,
      confirmLabel: 'Close',
      cancelLabel: 'Keep Copse open',
    })
  }
  return await showConfirmDialog({
    message: one
      ? 'Close Copse while the agent is still working?'
      : `Close Copse while ${String(titles.length)} threads are still working?`,
    detail: `${working} Closing stops the run — anything the agent has not already written to your files is lost.${containers}`,
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
    void confirmClose(store, {
      ...(req.continuesAfterQuit !== undefined
        ? { continuesAfterQuit: req.continuesAfterQuit }
        : {}),
      ...(req.containerRunThreads ? { containerRunThreads: req.containerRunThreads } : {}),
    }).then((confirmed) => api.closeConfirm.respond(req.id, confirmed))
  })
}
