import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { archiveThread, getActiveThread } from '@shared/store/thread-helpers.ts'
import { threadIsInactive } from '@shared/threads/auto-archive.ts'
import { invalidateProjectThreadLoads } from '../controller/persistence.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast } from './toast.ts'
import { showThreadArchiveToast } from './thread-archive-toast.ts'

/** A return-to-thread decision, shown only after main cannot establish completion. */
export function createThreadArchiveReview(
  store: AppStore,
  api: ApiClient,
): { element: HTMLElement; dispose(): void } {
  const element = el('section', {
    class: 'thread-archive-review',
    hidden: true,
    'aria-label': 'Review inactive thread',
  })
  const reason = el('p')
  const keep = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
    'Keep active',
  )
  const archive = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
    'Archive',
  )
  element.append(
    el('strong', {}, 'Finished with this thread?'),
    reason,
    el('div', { class: 'thread-archive-review-actions' }, keep, archive),
  )
  let generation = 0
  let selected = ''
  let disposed = false

  async function refresh(force = false): Promise<void> {
    const state = store.getState()
    const thread = getActiveThread(store)
    if (!state.activeProjectId || !thread || !threadIsInactive(thread, Date.now(), 3)) {
      selected = ''
      generation++
      element.hidden = true
      return
    }
    const key = `${state.activeProjectId}/${thread.id}/${String(thread.updatedAt)}`
    if (!force && selected === key) return
    selected = key
    const current = ++generation
    element.hidden = true
    const projectId = state.activeProjectId
    try {
      const result = await api.threads.archiveState(projectId, 'review')
      if (disposed || current !== generation) return
      const review = result.review.find((item) => item.threadId === thread.id)
      if (!review) return
      reason.textContent = `${review.reason} Archive keeps the conversation and files. You can restore it later.`
      element.hidden = false
      keep.onclick = (): void => {
        void decide('keep', projectId, thread.id)
      }
      archive.onclick = (): void => {
        void decide('archive', projectId, thread.id)
      }
    } catch (error) {
      console.warn('Could not check thread archive readiness', error)
    }
  }

  async function decide(
    action: 'keep' | 'archive',
    projectId: string,
    threadId: string,
  ): Promise<void> {
    const current = generation
    const title =
      store.getState().threads.find((thread) => thread.id === threadId)?.title ?? 'Thread'
    keep.disabled = true
    archive.disabled = true
    try {
      if (!(await api.threads.archiveDecision(projectId, threadId, action)))
        throw new Error('The thread changed or has pending work. Review it before archiving.')
      invalidateProjectThreadLoads(api, projectId)
      if (store.getState().activeProjectId === projectId) {
        if (action === 'archive') archiveThread(store, threadId)
        else {
          const threads = store
            .getState()
            .threads.map((thread) =>
              thread.id === threadId ? { ...thread, updatedAt: Date.now() } : thread,
            )
          store.setState({ threads })
          store.emit('threads_changed')
        }
      }
      if (action === 'archive') showThreadArchiveToast(store, api, projectId, threadId, title)
      if (generation === current) element.hidden = true
    } catch (error) {
      showErrorToast('Could not update thread', error)
    } finally {
      keep.disabled = false
      archive.disabled = false
    }
  }

  const sync = (): void => {
    void refresh()
  }
  const unsubs = [
    store.on('threads_changed', sync),
    store.on('thread_status_changed', sync),
    store.on('workspace_changed', sync),
    store.on('settings_changed', () => {
      void refresh(true)
    }),
  ]
  const onFocus = (): void => {
    void refresh(true)
  }
  window.addEventListener('focus', onFocus)
  sync()
  return {
    element,
    dispose: (): void => {
      disposed = true
      generation++
      window.removeEventListener('focus', onFocus)
      unsubs.forEach((unsubscribe) => {
        unsubscribe()
      })
    },
  }
}
