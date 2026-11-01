import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Thread } from '@shared/types'
import { buildFollowUpThread } from '@shared/store/follow-up-thread.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'

/**
 * Start a new, active thread that may read `sourceThreadId` without a consent
 * prompt. The composer stays empty apart from a chip naming the original; on send
 * the chip expands to the same pointer an `@thread` mention gives the agent.
 */
export function createFollowUpThread(
  store: AppStore,
  api: ApiClient,
  sourceThreadId: string,
): string | null {
  const source = getThreadById(store, sourceThreadId)
  const projectId = store.getState().activeProjectId
  if (!source || !projectId) return null
  const thread = buildFollowUpThread(source, store.getState().settings?.model ?? source.model)
  store.emit('composer_draft_flush')
  store.setState({
    threads: [thread, ...store.getState().threads],
    activeThreadId: thread.id,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('new_thread_opened')
  void attachSourceReference(store, api, projectId, source, thread.id)
  return thread.id
}

async function attachSourceReference(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  source: Thread,
  followUpId: string,
): Promise<void> {
  try {
    const hits = await api.threads.catalog(projectId, source.title)
    const hit = hits.find((candidate) => candidate.id === source.id)
    if (hit)
      store.emit('thread_reference_attach', followUpId, {
        threadId: hit.id,
        title: hit.title,
        updatedAt: hit.updatedAt,
        spinePath: hit.spinePath,
      })
  } catch (error) {
    console.error('[follow-up] could not reference the original thread:', error)
  }
}
