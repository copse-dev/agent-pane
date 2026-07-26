import type { Message, Thread } from '@shared/types'

/**
 * Forking a thread (issue: thread forking). A fork is a *new* thread seeded with
 * a copy of an existing conversation up to a chosen point, so a user can explore
 * a different direction without losing — or disturbing — the original.
 *
 * This module owns the pure data transform; the renderer controller
 * (`controller/fork-thread.ts`) inserts the result into the store, and the main
 * process seeds the fork's provider-format `agent-history.json` sidecar
 * (`services/thread-fork.ts`) so the agent resumes with the same context the
 * transcript shows.
 *
 * Two invariants matter here:
 *
 * 1. **Fresh message ids.** Several store helpers (`appendToken`,
 *    `setMessageContent`, `updateToolCall`, …) resolve a message by id across
 *    *every* thread, so a fork that reused ids would have its bubbles mutated by
 *    the source thread's live stream (and vice versa). Every copied message gets
 *    a new id. Tool-call ids are kept: they are only ever looked up under a
 *    message, they name per-thread blobs, and keeping them lines the transcript
 *    up with the provider history the fork inherits.
 * 2. **No inherited checkout.** A thread's linked worktree is owned by exactly
 *    one thread — its path is derived from the thread id
 *    (`expectedThreadWorktreePath`), so a copied `worktree` would fail
 *    validation and break the fork's first run. A fork therefore starts in
 *    shared mode; `gitBranch` carries over only when the source was itself
 *    shared.
 */

const randomUUID = (): string => globalThis.crypto.randomUUID()

/** Longest title we will build; keeps the sidebar row from overflowing. */
const MAX_TITLE_LENGTH = 120

const FORK_SUFFIX = ' (fork)'

/**
 * Title for a fork. Repeated forking stays readable — `Fix login (fork)` forks
 * to `Fix login (fork 2)`, then `(fork 3)` — rather than nesting suffixes.
 */
export function forkThreadTitle(title: string): string {
  const base = title.trim() || 'New Thread'
  const match = /^(.*) \(fork(?: (\d+))?\)$/.exec(base)
  if (match?.[1] !== undefined) {
    const next = match[2] === undefined ? 3 : Number(match[2]) + 1
    return truncateTitle(`${match[1]} (fork ${String(next)})`)
  }
  return truncateTitle(`${base}${FORK_SUFFIX}`)
}

function truncateTitle(title: string): string {
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

export interface ForkThreadOptions {
  /**
   * Fork through this message (inclusive) instead of the whole thread. An id
   * that isn't in the source thread forks nothing (`null`) rather than silently
   * copying everything.
   */
  throughMessageId?: string
  /**
   * Message ids to leave behind — the source thread's still-queued follow-ups.
   * They have not been sent to the model, so they are not part of the history a
   * fork inherits.
   */
  excludeMessageIds?: ReadonlySet<string>
}

/**
 * Build the fork of `source` without touching it. Returns `null` when the fork
 * would be empty — an unknown `throughMessageId`, or a slice that holds no
 * messages worth branching from.
 */
export function buildForkedThread(source: Thread, options: ForkThreadOptions = {}): Thread | null {
  const excluded = options.excludeMessageIds ?? new Set<string>()
  const settled = source.messages.filter((m) => !excluded.has(m.id))

  let slice: Message[]
  if (options.throughMessageId === undefined) {
    slice = settled
  } else {
    const cut = settled.findIndex((m) => m.id === options.throughMessageId)
    if (cut === -1) return null
    slice = settled.slice(0, cut + 1)
  }
  if (slice.length === 0) return null

  const now = Date.now()
  const messages = slice.map((message) => copyMessage(message))

  // A thread that owns a worktree cannot lend it to a fork (see the module
  // note), so the fork runs shared. Its branch binding only makes sense when the
  // source was shared too — otherwise the composer would warn about a mismatch
  // against a branch the fork never checks out.
  const gitBranch = source.worktree === undefined ? source.gitBranch : undefined

  return {
    id: randomUUID(),
    title: forkThreadTitle(source.title),
    status: 'idle',
    messages,
    // Usage is a ledger of what a thread spent. The fork has spent nothing yet;
    // the source keeps its own totals.
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.todos !== undefined ? { todos: source.todos.map((todo) => ({ ...todo })) } : {}),
    ...(source.workingBrief !== undefined ? { workingBrief: source.workingBrief } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Copy one message under a fresh id. Live/derived state is dropped: hook cards
 * are folded from the source thread's spine (the fork has no `hook_run` lines of
 * its own), and a post-turn review belongs to the run that produced it.
 */
function copyMessage(message: Message): Message {
  const {
    id: _id,
    hookCards: _hookCards,
    review: _review,
    toolCalls,
    images,
    attachments,
    ...rest
  } = message
  return {
    ...rest,
    id: randomUUID(),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    toolCalls: (toolCalls ?? []).map((toolCall) => ({ ...toolCall })),
    ...(images !== undefined ? { images: [...images] } : {}),
    ...(attachments !== undefined
      ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }
}
