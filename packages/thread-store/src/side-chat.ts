import type { Message, SideChatLink, Thread } from './thread-types.ts'

/**
 * Side chats (prototype #3538). A side chat is an ordinary thread (own id, own
 * model, own usage, archivable) that carries a {@link SideChatLink} to the message
 * it branched from. It is hidden from thread browsers by default, nested under
 * its parent in the Context panel, and archived rather than deleted.
 *
 * This module is the pure model. Persistence is the normal thread store; the
 * SQLite projection indexes the link so "which side chats does this thread have"
 * is one indexed read (see `sqlite-thread-index.ts`).
 *
 * Context semantics: the side chat's agent history is seeded once, at creation,
 * from the parent transcript up to and including the anchor (the existing
 * `threads:fork` history seeding, applied to a side chat id). It is a snapshot,
 * so later parent edits are not visible, which is the "reads up to here" the
 * prototype promises.
 */

const MAX_TITLE_LENGTH = 80

export interface SideChatOptions {
  /** The parent message to branch from. Unknown ids build nothing. */
  anchorMessageId: string
  /** Own model for the side chat; defaults to the parent's current override. */
  model?: string
  title?: string
}

/** The side-chat link of a thread, if it is one. */
export function sideChatLink(thread: Pick<Thread, 'sideChat'>): SideChatLink | undefined {
  return thread.sideChat
}

function excerpt(message: Message): string {
  const line = message.content.trim().split('\n', 1)[0] ?? ''
  return line.length <= MAX_TITLE_LENGTH ? line : `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

/**
 * Build a side chat from `parent` without touching it. Returns `null` when the
 * anchor is not a message of the parent, or when the parent is itself a side
 * chat: side chats branch from main threads only, so there are no chains.
 */
export function buildSideChatThread(parent: Thread, options: SideChatOptions): Thread | null {
  if (parent.sideChat !== undefined) return null
  const anchor = parent.messages.find((message) => message.id === options.anchorMessageId)
  if (!anchor) return null
  const model = options.model ?? parent.model
  const now = Date.now()
  return {
    id: globalThis.crypto.randomUUID(),
    title: options.title ?? (excerpt(anchor) || 'Side chat'),
    status: 'idle',
    messages: [],
    // A fresh side chat has nothing to scan: mark both caches as scanned and empty so
    // the index never queues it for a transcript backfill.
    prRefs: [],
    links: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(model !== undefined ? { model } : {}),
    sideChat: { parentThreadId: parent.id, anchorMessageId: anchor.id },
    createdAt: now,
    updatedAt: now,
  }
}

/** What the Context panel and the sidebar dot need about one side chat. */
export interface SideChatRow {
  id: string
  title: string
  model?: string
  anchorMessageId: string
  archived: boolean
  /** An agent reply landed while the side chat was not open. */
  unread: boolean
  createdAt: number
  updatedAt: number
}

export function toSideChatRow(thread: Thread): SideChatRow | null {
  const link = thread.sideChat
  if (link === undefined) return null
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.model !== undefined ? { model: thread.model } : {}),
    anchorMessageId: link.anchorMessageId,
    archived: thread.archivedAt != null,
    unread: thread.unreadAt !== undefined,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}

/** Side chats of `parentId`, oldest first. Archived ones are opt-in. */
export function sideChatsOf(
  threads: readonly Thread[],
  parentId: string,
  includeArchived = false,
): SideChatRow[] {
  const rows: SideChatRow[] = []
  for (const thread of threads) {
    if (thread.sideChat?.parentThreadId !== parentId) continue
    const row = toSideChatRow(thread)
    if (row && (includeArchived || !row.archived)) rows.push(row)
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** Thread-browser view: side chats are hidden by default. */
export function withoutSideChats<T extends Pick<Thread, 'sideChat'>>(threads: readonly T[]): T[] {
  return threads.filter((thread) => thread.sideChat === undefined)
}

/**
 * Unread side chats roll up to their parent so a browser row can show one dot
 * without listing the side chats. Archived side chats never count.
 */
export function unreadSideChatParents(
  threads: readonly Pick<Thread, 'sideChat' | 'unreadAt' | 'archivedAt'>[],
): Set<string> {
  const parents = new Set<string>()
  for (const thread of threads) {
    if (thread.sideChat && thread.unreadAt !== undefined && thread.archivedAt == null)
      parents.add(thread.sideChat.parentThreadId)
  }
  return parents
}
