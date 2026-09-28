import type { AppStore } from '@shared/store/store.ts'
import type { MobileChatCommand, MobileChatResult } from '@shared/mobile-chat.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  applyPreparedThreadCheckout,
  createThread,
  getThreadById,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { beginThreadSubmission, endThreadSubmission } from '@shared/store/pending-submissions.ts'
import { activateMobileProject } from './projects.ts'
import { awaitPendingThreadPersistence } from './persistence.ts'
import { ensureThreadMessages, hydrationFailed } from './thread-hydration.ts'
import { dispatchAgentRun, enqueueUserMessage, startHumanTurnTree } from './message-queue.ts'

/** Human phone submissions use the desktop's checkout, transcript, queue and run controller. */
export async function acceptMobileChat(
  store: AppStore,
  api: ApiClient,
  command: MobileChatCommand,
): Promise<MobileChatResult> {
  let ownedThread: string | null = null
  const checkCurrent = (): void => {
    if (Date.now() >= command.expiresAt) throw new Error('This send expired. Try again.')
    if (store.getState().activeProjectId !== command.projectId)
      throw new Error('The desktop changed projects during this send. Try again.')
  }
  try {
    if (Date.now() >= command.expiresAt) throw new Error('This send expired. Try again.')
    await activateMobileProject(store, api, command.projectId)
    checkCurrent()
    const threadId = command.threadId ?? createThread(store)
    const initial = getThreadById(store, threadId)
    if (!initial || initial.archivedAt !== undefined) throw new Error('Thread unavailable.')
    if (!beginThreadSubmission(store, threadId))
      throw new Error('Another message is being submitted to this thread. Try again shortly.')
    ownedThread = threadId
    switchThread(store, threadId)
    await awaitPendingThreadPersistence()
    await ensureThreadMessages(command.projectId, threadId)
    checkCurrent()
    if (hydrationFailed(threadId) || getThreadById(store, threadId)?.messagesLoaded === false)
      throw new Error('The desktop could not load the conversation. Try again.')
    if (!initial.worktreeChoice && initial.messages.length === 0) {
      const prepared = await api.agent.prepareCheckout(
        command.projectId,
        threadId,
        command.text,
        'automatic',
        initial.model,
      )
      checkCurrent()
      applyPreparedThreadCheckout(store, threadId, prepared)
    }
    const current = getThreadById(store, threadId)
    if (!current || current.archivedAt !== undefined) throw new Error('Thread unavailable.')
    checkCurrent()
    const payload = { content: command.text }
    const messageId = addMessage(store, threadId, 'user', command.text)
    const queued = { messageId, payload, createdAt: Date.now() }
    const running = current.status === 'running'
    if (running) enqueueUserMessage(store, threadId, queued)
    else {
      startHumanTurnTree(store, threadId)
      dispatchAgentRun(store, api, threadId, payload, queued)
    }
    return { ok: true, threadId, queued: running }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The desktop could not send this message.',
    }
  } finally {
    if (ownedThread) endThreadSubmission(store, ownedThread)
  }
}

export function attachMobileChat(
  store: AppStore,
  api: ApiClient,
  ready: Promise<void>,
): () => void {
  return api.mobile.onChat((command) => {
    void ready
      .then(() => acceptMobileChat(store, api, command))
      .then((result) => api.mobile.reply(command.id, result))
  })
}
