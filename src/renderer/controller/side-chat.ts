import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { buildSideChatThread } from '@shared/threads/side-chat.ts'
import { queuedMessageIds } from './message-queue.ts'

export interface StartSideChatOptions {
  /** Parent message to branch from; defaults to the parent's latest settled message. */
  anchorMessageId?: string
  /** Own model for the side chat; defaults to the parent's override. */
  model?: string
}

/**
 * Start a side chat from `parentThreadId` and open it. Returns the new thread id,
 * or `null` when there is nothing to branch from (unknown or empty parent, an
 * unknown anchor, or a parent that is itself a side chat).
 *
 * The side chat is inserted the way a fork is, so autosave sees a new id and
 * flushes `threads:create` before the history seed runs. Unlike a fork its
 * transcript starts empty: only the agent's provider history is seeded, from the
 * parent up to the anchor, through the same `threads:fork` main-process path.
 */
export async function startSideChat(
  store: AppStore,
  api: ApiClient,
  parentThreadId: string,
  options: StartSideChatOptions = {},
): Promise<string | null> {
  const parent = getThreadById(store, parentThreadId)
  if (!parent) return null

  // Queued follow-ups have not been sent to the model, so they are not context.
  const queued = queuedMessageIds(parent)
  const anchorMessageId =
    options.anchorMessageId ?? parent.messages.filter((m) => !queued.has(m.id)).at(-1)?.id
  if (anchorMessageId === undefined || queued.has(anchorMessageId)) return null

  const side = buildSideChatThread(parent, {
    anchorMessageId,
    ...(options.model !== undefined ? { model: options.model } : {}),
  })
  if (!side) return null

  store.emit('composer_draft_flush')
  store.setState({
    threads: [side, ...store.getState().threads],
    activeThreadId: side.id,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('panel_changed')

  const projectId = store.getState().activeProjectId
  if (projectId) {
    try {
      await api.threads.fork(projectId, parentThreadId, side.id, anchorMessageId)
    } catch (error) {
      // The side chat is still usable; it just starts without the parent's context.
      console.error('[side-chat] failed to seed history from the parent:', error)
    }
  }
  return side.id
}
