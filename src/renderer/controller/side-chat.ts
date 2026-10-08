import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AgentRunPayload } from '@shared/types/skills.ts'
import type { Thread } from '@shared/types'
import { collectThreadPrRefs } from '@shared/git/thread-pr-status.ts'
import { buildForkedThread } from '@shared/store/fork-thread.ts'
import { archiveThread, addMessage, getThreadById } from '@shared/store/thread-helpers.ts'
import { collectThreadLinks } from '@shared/threads/thread-links.ts'
import { buildSideChatThread } from '@shared/threads/side-chat.ts'
import { attentionThreadId } from './projects.ts'
import {
  dispatchAgentRun,
  enqueueUserMessage,
  queuedMessageIds,
  startHumanTurnTree,
} from './message-queue.ts'

export interface StartSideChatOptions {
  /** Parent message to branch from; defaults to the parent's latest settled message. */
  anchorMessageId?: string
  /** Own model for the side chat; defaults to the parent's override. */
  model?: string
  /**
   * Where the side chat opens. `panel` (default) shows it beside the main thread in
   * the Side chat panel and leaves the main thread active; `thread` makes it the
   * active thread instead.
   */
  open?: 'panel' | 'thread'
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
 * By default it opens beside the main thread (the Side chat panel) rather than
 * replacing it.
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

  const openAs = options.open ?? 'panel'
  if (openAs === 'thread') {
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
  } else {
    // The main thread stays active; autosave sees the new id and flushes its create.
    store.setState({ threads: [side, ...store.getState().threads] })
    store.emit('threads_changed')
    store.emit('side_chat_open_requested', side.id)
  }

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

/**
 * Ask a side chat a question. A side chat is driven like any thread (a user message,
 * then an agent run on its own id) but never becomes the active thread, so the main
 * conversation is untouched. Returns the new message id, or `null` for an unknown
 * thread, a thread that is not a side chat, or blank text. While a turn is running
 * the question queues behind it, as it would in the main composer.
 */
export function sendSideChatMessage(
  store: AppStore,
  api: ApiClient,
  sideThreadId: string,
  text: string,
): string | null {
  const side = getThreadById(store, sideThreadId)
  const prompt = text.trim()
  if (!side || side.sideChat === undefined || prompt === '') return null
  const messageId = addMessage(store, sideThreadId, 'user', prompt)
  const payload: AgentRunPayload = {
    content: prompt,
    invokedSkills: [],
    priorTodos: side.todos ?? [],
    ...(side.workingBrief !== undefined ? { workingBrief: side.workingBrief } : {}),
  }
  const queued = { messageId, payload, createdAt: Date.now() }
  if (side.status === 'running') {
    enqueueUserMessage(store, sideThreadId, queued)
  } else {
    startHumanTurnTree(store, sideThreadId)
    dispatchAgentRun(store, api, sideThreadId, payload, queued)
  }
  return messageId
}

/**
 * Turn a side chat into an ordinary thread and open it. The new thread's transcript
 * is the parent's conversation up to the anchor followed by the side chat's own
 * turns, so it reads as one conversation; its agent history is copied from the side
 * chat (which already holds the parent context plus its own turns). The side chat
 * is archived, not deleted. Built as a fresh thread rather than by editing the side
 * chat in place because persistence writes new messages only as they are appended.
 *
 * Returns the new thread id, or `null` for an unknown thread or one that is not a
 * side chat. A side chat with nothing to carry over (orphaned and empty) is simply
 * detached from its link in place.
 */
export async function promoteSideChat(
  store: AppStore,
  api: ApiClient,
  sideThreadId: string,
): Promise<string | null> {
  const side = getThreadById(store, sideThreadId)
  if (!side || side.sideChat === undefined) return null
  const parent = getThreadById(store, side.sideChat.parentThreadId)

  const prefix = parent
    ? buildForkedThread(parent, {
        throughMessageId: side.sideChat.anchorMessageId,
        excludeMessageIds: queuedMessageIds(parent),
      })
    : null
  const own = buildForkedThread(side)
  const base = own ?? prefix
  if (!base) {
    const { sideChat: _link, ...detached } = side
    store.setState({
      threads: store.getState().threads.map((t) => (t.id === sideThreadId ? detached : t)),
    })
    store.emit('threads_changed')
    return sideThreadId
  }

  const messages = [...(prefix?.messages ?? []), ...(own?.messages ?? [])]
  const promoted: Thread = {
    ...base,
    title: side.title,
    messages,
    prRefs: collectThreadPrRefs({ messages }),
    links: collectThreadLinks({ id: base.id, messages }),
    ...(side.model !== undefined ? { model: side.model } : {}),
  }
  store.emit('composer_draft_flush')
  store.setState({
    threads: [promoted, ...store.getState().threads],
    activeThreadId: promoted.id,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('panel_changed')
  archiveThread(store, sideThreadId)

  const projectId = store.getState().activeProjectId
  if (projectId) {
    try {
      if (own) await api.threads.fork(projectId, sideThreadId, promoted.id)
      else if (parent)
        await api.threads.fork(projectId, parent.id, promoted.id, side.sideChat.anchorMessageId)
    } catch (error) {
      console.error('[side-chat] failed to seed the promoted thread history:', error)
    }
  }
  return promoted.id
}

/**
 * Names the side chats behind a set of prompts (approvals, `ask_user` questions)
 * that surface over their parent thread, so the prompt says which conversation is
 * asking. `null` when none of them comes from a side chat.
 */
export function sideChatPromptOrigin(
  store: AppStore,
  threadIds: Iterable<string | undefined>,
): { label: string; firstSideChatId: string } | null {
  const titles: string[] = []
  let firstSideChatId: string | undefined
  for (const id of new Set(threadIds)) {
    if (id === undefined || attentionThreadId(store, id) === id) continue
    firstSideChatId ??= id
    const title = getThreadById(store, id)?.title ?? ''
    titles.push(`“${title === '' ? 'Side chat' : title}”`)
  }
  if (firstSideChatId === undefined) return null
  return {
    label:
      titles.length === 1
        ? `From the side chat ${titles.join('')}`
        : `From the side chats ${titles.join(', ')}`,
    firstSideChatId,
  }
}
