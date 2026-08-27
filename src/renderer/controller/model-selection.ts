import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

type ModelSelectionApi = {
  threads: Pick<ApiClient['threads'], 'recordModelSelection'>
}

/** Commit a model change locally and append its actor-attributed audit event in main. */
export function commitThreadModelSelection(
  store: AppStore,
  api: ModelSelectionApi,
  threadId: string,
  by: 'user' | 'auto',
  from: string | undefined,
  to: string,
): void {
  if (from === to) return
  store.setState({
    threads: store
      .getState()
      .threads.map((thread) =>
        thread.id === threadId ? { ...thread, model: to, updatedAt: Date.now() } : thread,
      ),
  })
  store.emit('threads_changed')

  const projectId = store.getState().activeProjectId
  if (!projectId) return
  void api.threads
    .recordModelSelection(projectId, threadId, by, from, to)
    .then((selection) => {
      store.setState({
        threads: store.getState().threads.map((thread) => {
          if (thread.id !== threadId) return thread
          if (thread.modelSelections?.some((candidate) => candidate.id === selection.id)) {
            return thread
          }
          return {
            ...thread,
            modelSelections: [...(thread.modelSelections ?? []), selection],
          }
        }),
      })
      store.emit('threads_changed')
    })
    .catch((error: unknown) => {
      console.error('[models] could not record thread model selection', error)
    })
}
