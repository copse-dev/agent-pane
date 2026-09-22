import type { Message, Thread } from '@shared/types'
import { isImportedCursorAgentThread } from '@shared/remote-agent-link.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function refreshKey(projectId: string, thread: Thread): string | null {
  const link = thread.remoteAgentLink
  if (
    thread.status !== 'idle' ||
    thread.queuePaused === true ||
    (thread.pendingMessages?.length ?? 0) > 0 ||
    thread.messagesLoaded === false ||
    link?.provider !== 'cursor' ||
    !isImportedCursorAgentThread(thread) ||
    !link.runId
  ) {
    return null
  }
  return `${projectId}:${thread.id}:${link.agentId}:${link.runId}`
}

/** Apply one main-owned persisted result without replacing a live in-memory tail. */
export function mergeImportedCursorResult(thread: Thread, message: Message): Thread {
  if (thread.messages.some((current) => current.id === message.id)) return thread
  return {
    ...thread,
    messages: [...thread.messages, message],
    updatedAt: Math.max(thread.updatedAt, message.createdAt),
  }
}

/**
 * Fetch one durable terminal result when an imported Cursor thread is opened.
 *
 * This deliberately does not participate in account-wide discovery or a timer:
 * it only observes the visible, hydrated thread. A response is discarded when
 * the project, selection, link, or turn status changed while the request ran.
 */
export function attachImportedCursorAgentRefresh(store: AppStore, api: ApiClient): () => void {
  let lastAttemptKey: string | null = null

  const refreshActive = (): void => {
    const initial = store.getState()
    const projectId = initial.activeProjectId
    const threadId = initial.activeThreadId
    const thread = threadId
      ? initial.threads.find((candidate) => candidate.id === threadId)
      : undefined
    const key = projectId && thread ? refreshKey(projectId, thread) : null
    if (!projectId || !threadId || !thread || !key) {
      lastAttemptKey = null
      return
    }
    if (lastAttemptKey === key) return
    lastAttemptKey = key

    void api.remoteAgent
      .refreshImportedThread(projectId, threadId)
      .then((message) => {
        if (!message) return
        const current = store.getState()
        if (current.activeProjectId !== projectId || current.activeThreadId !== threadId) return
        const active = current.threads.find((candidate) => candidate.id === threadId)
        if (!active || refreshKey(projectId, active) !== key) return
        const merged = mergeImportedCursorResult(active, message)
        if (merged === active) return
        store.setState({
          threads: current.threads.map((candidate) =>
            candidate.id === threadId ? merged : candidate,
          ),
        })
        store.emit('threads_changed')
      })
      .catch((err: unknown) => {
        // A missing key, temporary network error, or unavailable run should not
        // interrupt opening a saved conversation. Selecting it again retries.
        console.debug('[imported-cursor-agent-refresh] skipped:', err)
        if (lastAttemptKey === key) lastAttemptKey = null
      })
  }

  const offThreads = store.on('threads_changed', refreshActive)
  const offWorkspace = store.on('workspace_changed', refreshActive)
  refreshActive()
  return (): void => {
    offThreads()
    offWorkspace()
  }
}
