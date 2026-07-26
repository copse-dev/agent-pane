import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ForkedHistoryResult, Thread } from '@shared/types'
import { buildForkedThread, type ForkThreadOptions } from '@shared/store/fork-thread.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { queuedMessageIds } from './message-queue.ts'

/**
 * Forking a conversation. The visible transcript is copied in the renderer (so
 * the fork appears and becomes active immediately); its provider-format history
 * is seeded in main, where `agent-history.json` lives — see
 * `main/services/thread-fork.ts` for why a whole-thread fork copies that sidecar
 * verbatim while a fork from an earlier message rebuilds it from the transcript.
 */

export interface ForkResult {
  threadId: string
  /** How main seeded the fork's provider history; `null` if that step failed. */
  history: ForkedHistoryResult | null
  /**
   * True when the fork's history had to be rebuilt *and* the copied transcript
   * carries attachment chips — the fenced blocks those chips stood for only ever
   * existed in the original run payload, so the fork's model context lacks them.
   */
  droppedAttachments: boolean
}

function hasAttachments(thread: Thread): boolean {
  return thread.messages.some((m) => (m.attachments ?? []).length > 0)
}

/**
 * Fork `sourceThreadId` into a new thread and make it active. Returns `null`
 * when there is nothing to fork (unknown thread, or a slice with no messages).
 *
 * The new thread is inserted the way `createThread` does — prepended and
 * selected, with the per-thread file/diff viewer reset — so autosave sees a new
 * id and flushes its `threads:create` immediately, before the fork IPC runs.
 */
export async function forkThread(
  store: AppStore,
  api: ApiClient,
  sourceThreadId: string,
  options: Pick<ForkThreadOptions, 'throughMessageId'> = {},
): Promise<ForkResult | null> {
  const source = getThreadById(store, sourceThreadId)
  if (!source) return null

  // Queued follow-ups have not been sent to the model, so they are not part of
  // the history a fork inherits — they stay behind on the source thread.
  const forked = buildForkedThread(source, {
    ...options,
    excludeMessageIds: queuedMessageIds(source),
  })
  if (!forked) return null

  store.emit('composer_draft_flush')
  store.setState({
    threads: [forked, ...store.getState().threads],
    activeThreadId: forked.id,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('panel_changed')

  const projectId = store.getState().activeProjectId
  if (!projectId) return { threadId: forked.id, history: null, droppedAttachments: false }

  let history: ForkedHistoryResult | null = null
  try {
    history = await api.threads.fork(projectId, sourceThreadId, forked.id, options.throughMessageId)
  } catch (error) {
    // The fork itself is already usable — only its inherited model context is
    // missing, which the caller surfaces. Never leave the user without a thread.
    console.error('[fork] failed to seed forked thread history:', error)
  }
  return {
    threadId: forked.id,
    history,
    droppedAttachments: history?.source === 'rebuilt' && hasAttachments(forked),
  }
}
