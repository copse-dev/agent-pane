// Use the Web Crypto API available in both browsers and Node 19+
const randomUUID = (): string => globalThis.crypto.randomUUID()
import type { AppStore } from './store.ts'
import { at } from '@shared/array-utils.ts'
import type {
  Message,
  ModelUsage,
  ToolCall,
  ThreadUsage,
  UsageDelta,
  ContextTrimRecord,
  ContextSnapshot,
  TranscriptAttachment,
} from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ModelComparison, Thread, ThreadReview } from '@shared/types'

export function sortThreadsNewestFirst(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.createdAt - a.createdAt)
}

/** Look up a thread by id (undefined for null/unknown ids). */
export function getThreadById(store: AppStore, id: string | null | undefined): Thread | undefined {
  if (!id) return undefined
  return store.getState().threads.find((t) => t.id === id)
}

/** The currently active thread, if any. */
export function getActiveThread(store: AppStore): Thread | undefined {
  return getThreadById(store, store.getState().activeThreadId)
}

/** Empty idle thread with no messages yet (unused "New Thread"). */
export function isBlankThread(thread: Thread): boolean {
  return thread.messages.length === 0 && thread.status === 'idle'
}

export function hasUnsubmittedPrompt(thread: Thread): boolean {
  return Boolean(thread.draftPrompt?.trim())
}

/** Blank thread with no draft — safe to collapse when switching away. */
function isPrunableBlankThread(thread: Thread): boolean {
  return isBlankThread(thread) && !hasUnsubmittedPrompt(thread)
}

function pruneBlankThreads(store: AppStore, keepIds: ReadonlySet<string>): void {
  const { threads, activeThreadId } = store.getState()
  const remaining = threads.filter((t) => !isPrunableBlankThread(t) || keepIds.has(t.id))
  if (remaining.length === 0 || remaining.length === threads.length) return
  const newActive =
    activeThreadId && remaining.some((t) => t.id === activeThreadId)
      ? activeThreadId
      : (remaining[0]?.id ?? null)
  store.setState({ threads: remaining, activeThreadId: newActive })
  store.emit('threads_changed')
}

/** Drop extra blank threads after load (keeps drafts and one empty blank). */
export function normalizeBlankThreads(store: AppStore): void {
  const { threads, activeThreadId } = store.getState()
  const blanks = threads.filter(isBlankThread)
  const emptyBlanks = blanks.filter((t) => !hasUnsubmittedPrompt(t))
  if (emptyBlanks.length <= 1) return
  const keepEmptyId =
    emptyBlanks.find((t) => t.id === activeThreadId)?.id ??
    at(
      emptyBlanks.sort((a, b) => b.createdAt - a.createdAt),
      0,
    ).id
  const keepIds = new Set([...blanks.filter(hasUnsubmittedPrompt).map((t) => t.id), keepEmptyId])
  pruneBlankThreads(store, keepIds)
}

export function createThread(store: AppStore): string {
  const id = randomUUID()
  const defaultModel = store.getState().settings?.model
  const threads = [
    {
      id,
      title: 'New Thread',
      status: 'idle' as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      // Only set model when a default exists; omit under exactOptionalPropertyTypes
      // rather than assigning undefined. Absent means "use the global default".
      ...(defaultModel !== undefined ? { model: defaultModel } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...store.getState().threads,
  ]
  // Keep the side/bottom panel (`filesPaneOpen`) open across new threads, matching
  // `switchThread`; only the per-thread file/diff viewer content is reset.
  store.setState({
    threads,
    activeThreadId: id,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('panel_changed')
  store.emit('new_thread_opened')
  return id
}

/** Open a fresh composer: reuse an unused blank thread or create one. */
export function openNewThread(store: AppStore): string {
  const { threads, activeThreadId } = store.getState()
  const existing = threads.find((t) => isBlankThread(t) && !hasUnsubmittedPrompt(t))
  if (existing) {
    if (activeThreadId !== existing.id) {
      store.emit('composer_draft_flush')
      // Reset the model to the current global default when reusing an existing
      // blank thread, so the picker reflects the settings page default rather
      // than whatever model was last chosen on a prior conversation.
      const defaultModel = store.getState().settings?.model
      store.setState({
        activeThreadId: existing.id,
        threads: threads.map((t) => {
          if (t.id !== existing.id) return t
          // Drop any prior per-thread model and re-seed from the global default
          // (omit entirely when there is no default, per exactOptionalPropertyTypes).
          const { model: _prevModel, ...rest } = t
          return defaultModel !== undefined ? { ...rest, model: defaultModel } : rest
        }),
      })
      store.emit('threads_changed')
    }
    pruneBlankThreads(store, new Set([existing.id]))
    store.emit('threads_changed')
    // Keep the side/bottom panel open; only reset the file/diff viewer content.
    store.setState({
      openFile: null,
      activeDiff: null,
      stagedDiffs: [],
    })
    store.emit('panel_changed')
    store.emit('new_thread_opened')
    return existing.id
  }
  store.emit('composer_draft_flush')
  return createThread(store)
}

export function switchThread(store: AppStore, id: string): void {
  if (id === store.getState().activeThreadId) return
  store.emit('composer_draft_flush')
  store.setState({ activeThreadId: id })
  store.emit('threads_changed')
  pruneBlankThreads(store, new Set([id]))
  store.emit('threads_changed')
}

export function deleteThread(store: AppStore, id: string): void {
  const { threads, activeThreadId } = store.getState()
  const remaining = threads.filter((t) => t.id !== id)
  if (remaining.length === 0) {
    // Deleting the only thread: create a fresh replacement (which also becomes
    // active), then drop the deleted one. createThread prepends the new thread
    // and sets it active, so we filter out `id`, not the new thread.
    createThread(store)
    store.setState({
      threads: store.getState().threads.filter((t) => t.id !== id),
    })
    store.emit('threads_changed')
    return
  }
  const index = threads.findIndex((t) => t.id === id)
  const newActive =
    activeThreadId === id
      ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null)
      : activeThreadId
  store.setState({ threads: remaining, activeThreadId: newActive })
  store.emit('threads_changed')
}

export function recordContextTrim(
  store: AppStore,
  threadId: string,
  record: Omit<ContextTrimRecord, 'at'>,
): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const entry: ContextTrimRecord = { ...record, at: Date.now() }
    return {
      ...t,
      contextTrims: [...(t.contextTrims ?? []), entry],
      updatedAt: Date.now(),
    }
  })
  store.setState({ threads })
  store.emit('threads_changed')
}

export function addMessage(
  store: AppStore,
  threadId: string,
  role: Message['role'],
  content = '',
  images?: string[],
  attachments?: TranscriptAttachment[],
): string {
  const id = randomUUID()
  const { threads } = store.getState()
  const updated = threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          messages: [
            ...t.messages,
            {
              id,
              role,
              content,
              ...(images?.length ? { images } : {}),
              ...(attachments?.length ? { attachments } : {}),
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads: updated })
  store.emit('message_added', threadId, id)

  const thread = updated.find((t) => t.id === threadId)
  if (thread && thread.messages.length === 1) {
    pruneBlankThreads(store, new Set([threadId]))
  }

  return id
}

export function setThreadDraftPrompt(store: AppStore, threadId: string, draftPrompt: string): void {
  const trimmed = draftPrompt.trim()
  const { threads } = store.getState()
  const thread = threads.find((t) => t.id === threadId)
  if (!thread) return
  if (trimmed.length > 0) {
    if (thread.draftPrompt === draftPrompt) return
    const updated = threads.map((t) =>
      t.id !== threadId ? t : { ...t, draftPrompt, updatedAt: Date.now() },
    )
    store.setState({ threads: updated })
    store.emit('thread_draft_changed', threadId)
    return
  }
  if (thread.draftPrompt === undefined) return
  const updated = threads.map((t) => {
    if (t.id !== threadId) return t
    const { draftPrompt: _removed, ...rest } = t
    return { ...rest, updatedAt: Date.now() }
  })
  store.setState({ threads: updated })
  store.emit('thread_draft_changed', threadId)
}

export function appendToken(store: AppStore, messageId: string, text: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, content: m.content + text })),
  }))
  store.setState({ threads: updated })
  store.emit('message_token', messageId, text)
}

export function appendReasoning(store: AppStore, messageId: string, text: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId ? m : { ...m, reasoning: (m.reasoning ?? '') + text },
    ),
  }))
  store.setState({ threads: updated })
  store.emit('message_reasoning', messageId, text)
}

export function setMessageContent(store: AppStore, messageId: string, content: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, content })),
  }))
  store.setState({ threads: updated })
  store.emit('message_token', messageId, content)
}

export function setMessageCommandSummary(
  store: AppStore,
  messageId: string,
  commandSummary: string,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) => (m.id !== messageId ? m : { ...m, commandSummary })),
  }))
  store.setState({ threads: updated })
  // Re-uses the tool-card refresh path so the shell group header updates in place.
  store.emit('tool_call_updated', messageId, '')
}

export function addToolCall(store: AppStore, messageId: string, toolCall: ToolCall): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            toolCalls: [...m.toolCalls, toolCall],
          },
    ),
  }))
  store.setState({ threads: updated })
  store.emit('tool_call_started', messageId, toolCall)
}

export function findToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
): ToolCall | undefined {
  for (const thread of store.getState().threads) {
    for (const message of thread.messages) {
      if (message.id !== messageId) continue
      return message.toolCalls.find((tc) => tc.id === toolCallId)
    }
  }
  return undefined
}

export function updateToolCall(
  store: AppStore,
  messageId: string,
  toolCallId: string,
  patch: Partial<ToolCall>,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => ({
    ...t,
    messages: t.messages.map((m) =>
      m.id !== messageId
        ? m
        : {
            ...m,
            toolCalls: m.toolCalls.map((tc) => (tc.id !== toolCallId ? tc : { ...tc, ...patch })),
          },
    ),
  }))
  store.setState({ threads: updated })
  store.emit('tool_call_updated', messageId, toolCallId)
}

export function updateUsage(store: AppStore, threadId: string, usage: ThreadUsage): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, usage }))
  store.setState({ threads: updated })
  store.emit('usage_updated', threadId)
}

function addCacheTokens<T extends ModelUsage>(
  base: T,
  prevRead: number | undefined,
  prevCreation: number | undefined,
  delta: UsageDelta,
): T {
  const next: T = { ...base }
  if (delta.cacheReadTokens !== undefined || prevRead !== undefined) {
    next.cacheReadTokens = (prevRead ?? 0) + (delta.cacheReadTokens ?? 0)
  }
  if (delta.cacheCreationTokens !== undefined || prevCreation !== undefined) {
    next.cacheCreationTokens = (prevCreation ?? 0) + (delta.cacheCreationTokens ?? 0)
  }
  return next
}

export function addUsageDelta(store: AppStore, threadId: string, delta: UsageDelta): void {
  const thread = getThreadById(store, threadId)
  if (!thread) return
  const byModel = { ...(thread.usage.byModel ?? {}) }
  const prev = byModel[delta.model] ?? { inputTokens: 0, outputTokens: 0 }
  byModel[delta.model] = addCacheTokens(
    {
      inputTokens: prev.inputTokens + delta.inputTokens,
      outputTokens: prev.outputTokens + delta.outputTokens,
    },
    prev.cacheReadTokens,
    prev.cacheCreationTokens,
    delta,
  )
  updateUsage(
    store,
    threadId,
    addCacheTokens(
      {
        inputTokens: thread.usage.inputTokens + delta.inputTokens,
        outputTokens: thread.usage.outputTokens + delta.outputTokens,
        byModel,
      },
      thread.usage.cacheReadTokens,
      thread.usage.cacheCreationTokens,
      delta,
    ),
  )
}

export function updateContextSnapshot(
  store: AppStore,
  threadId: string,
  snapshot: Omit<ContextSnapshot, 'updatedAt'>,
): void {
  const threads = store.getState().threads.map((t) =>
    t.id !== threadId
      ? t
      : {
          ...t,
          contextSnapshot: { ...snapshot, updatedAt: Date.now() },
          updatedAt: Date.now(),
        },
  )
  store.setState({ threads })
  store.emit('context_updated', threadId)
}

export function clearContextSnapshot(store: AppStore, threadId: string): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const { contextSnapshot: _removed, ...rest } = t
    return rest
  })
  store.setState({ threads })
  store.emit('context_updated', threadId)
}

export function setThreadTodos(store: AppStore, threadId: string, todos: TodoItem[]): void {
  const threads = store
    .getState()
    .threads.map((t) => (t.id !== threadId ? t : { ...t, todos, updatedAt: Date.now() }))
  store.setState({ threads })
  store.emit('todos_changed', threadId)
}

/** Store the post-turn review verdict for a thread (clears with `null`). */
export function setThreadReview(
  store: AppStore,
  threadId: string,
  review: ThreadReview | null,
): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const next = { ...t, updatedAt: Date.now() }
    if (review) next.review = review
    else delete next.review
    return next
  })
  store.setState({ threads })
  store.emit('review_changed', threadId)
}

/** Store the two-model comparison for a thread (clears with `null`). */
export function setThreadComparison(
  store: AppStore,
  threadId: string,
  comparison: ModelComparison | null,
): void {
  const threads = store.getState().threads.map((t) => {
    if (t.id !== threadId) return t
    const next = { ...t, updatedAt: Date.now() }
    if (comparison) next.comparison = comparison
    else delete next.comparison
    return next
  })
  store.setState({ threads })
  store.emit('comparison_changed', threadId)
}

/** Suspend/resume FIFO draining of a thread's queued messages (e.g. while editing). */
export function setQueuePaused(store: AppStore, threadId: string, paused: boolean): void {
  const { threads } = store.getState()
  const thread = threads.find((t) => t.id === threadId)
  if (!thread || Boolean(thread.queuePaused) === paused) return
  const updated = threads.map((t) => {
    if (t.id !== threadId) return t
    if (paused) return { ...t, queuePaused: true, updatedAt: Date.now() }
    const { queuePaused: _removed, ...rest } = t
    return { ...rest, updatedAt: Date.now() }
  })
  store.setState({ threads: updated })
  store.emit('threads_changed')
}

export function setThreadStatus(
  store: AppStore,
  threadId: string,
  status: 'idle' | 'running' | 'error',
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, status }))
  store.setState({ threads: updated })
  store.emit('thread_status_changed', threadId, status)
}

export function setThreadTitle(store: AppStore, threadId: string, title: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) => (t.id !== threadId ? t : { ...t, title }))
  store.setState({ threads: updated })
  store.emit('threads_changed')
}

export function setThreadWorkingBrief(
  store: AppStore,
  threadId: string,
  workingBrief: string,
): void {
  const { threads } = store.getState()
  const updated = threads.map((t) =>
    t.id !== threadId ? t : { ...t, workingBrief, updatedAt: Date.now() },
  )
  store.setState({ threads: updated })
  store.emit('threads_changed')
}

export function setThreadGitBranch(store: AppStore, threadId: string, branch: string): void {
  const { threads } = store.getState()
  const updated = threads.map((t) =>
    t.id !== threadId ? t : { ...t, gitBranch: branch, updatedAt: Date.now() },
  )
  store.setState({ threads: updated })
  store.emit('threads_changed')
}

/** Bind a thread to the checked-out branch on first message; never overwrites. */
export function bindThreadGitBranchIfUnset(
  store: AppStore,
  threadId: string,
  branch: string,
): void {
  const thread = getThreadById(store, threadId)
  if (!thread || thread.gitBranch) return
  setThreadGitBranch(store, threadId, branch)
}
