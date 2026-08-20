import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'

// On-disk persistence for projects and their chat threads. Projects stay in the
// shared electron-store (config.json). Threads live in the filesystem-native
// store (issue #644): the renderer maps store events onto event-level writes —
// `create` on a new thread, `appendMessage` on each finalized message, and a
// debounced `updateMeta` for metadata (draft/usage/status/todos/title/…) —
// instead of rewriting whole threads on every keystroke.

const KEY_PROJECTS = 'projects'
const KEY_ACTIVE = 'activeProjectId'

// Autosave fires several events per turn and project switches save/load
// concurrently, so writes to the same key could overlap and land out of order
// (a stale in-flight write completing after a newer one). Chain writes per key
// so they apply strictly in submission order; the latest-submitted value wins.
const writeChains = new Map<string, Promise<unknown>>()

export function serializedSet(api: ApiClient, key: string, value: unknown): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(() => api.storage.set(key, value))
  writeChains.set(key, next)
  void next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key)
  })
  return next
}

function serializedWrite(key: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(key)
  let next: Promise<void>
  if (prev) {
    next = prev.catch(() => undefined).then(write)
  } else {
    try {
      // Start the first IPC write synchronously. In particular, a new thread's
      // create must be sent before its immediately-following agent:run so main
      // can validate the project/thread pair without racing renderer autosave.
      next = write()
    } catch (error) {
      next = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  writeChains.set(key, next)
  void next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key)
  })
  return next
}

// All writes for one thread (create / appendMessage / updateMeta / delete) share
// this key so they run strictly in order — a create is guaranteed to land before
// the first append even though they are separate IPC channels.
const threadWriteKey = (projectId: string, threadId: string): string =>
  `thread:${projectId}:${threadId}`

type ThreadMeta = Omit<Thread, 'messages' | 'messagesLoaded'>

function metaOf(thread: Thread): ThreadMeta {
  // Mirror the main-process `metaOf`: `messagesLoaded` is session-local load
  // bookkeeping. Leaving it in would also make hydrating a thread look like a
  // metadata change and fire a pointless `updateMeta` write per thread opened.
  const { messages: _messages, messagesLoaded: _messagesLoaded, ...meta } = thread
  return meta
}

function metaSig(meta: ThreadMeta): string {
  return JSON.stringify(meta)
}

/**
 * Build the `updateMeta` patch for a changed thread. On disk `updateMeta` merges
 * `{ ...current, ...patch }`, which can set keys but never delete them — so a
 * field the renderer has dropped (a drained `pendingMessages`, a lifted
 * `queuePaused`, a cleared `contextSnapshot`) would otherwise linger in
 * `meta.json` and, on the next restore, resurrect a phantom "queued" message and
 * re-dispatch its run. Carry the full next meta plus an explicit `undefined` for
 * every key that was present in the last-persisted meta but is now gone: the
 * merge then writes `undefined`, which `JSON.stringify` drops, clearing the field
 * on disk. Fields the renderer never carries (main-owned `remoteAgentLink`) never
 * appear in `prev`, so they are never nulled and stay preserved by the merge.
 */
function metaPatch(prev: ThreadMeta, next: ThreadMeta): Partial<ThreadMeta> {
  const patch: Record<string, unknown> = { ...next }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) patch[key] = undefined
  }
  return patch
}

// Each thread's last-persisted metadata, keyed by project then thread id. A
// change event only rewrites `meta.json` when the metadata actually changed
// (compared by signature); created/deleted threads are detected by diffing the
// id set, and the retained object lets us compute which keys a change removed.
// Seeded from disk on load so a freshly loaded project produces no spurious
// writes and its deletions are still detected. Per-project so a project switch
// never mistakes the other project's threads for deletions.
const persistedMeta = new Map<string, Map<string, ThreadMeta>>()

/**
 * Diff a project's threads against the last-persisted metadata baseline and emit
 * exactly `create` (new id), `updateMeta` (changed meta), or `delete` (removed
 * id). Message content is persisted separately via `appendMessage`; a brand-new
 * thread's `create` writes its current messages too. Updates the baseline.
 */
function reconcileThreads(api: ApiClient, projectId: string, threads: Thread[]): Promise<void> {
  const prev = persistedMeta.get(projectId) ?? new Map<string, ThreadMeta>()
  const next = new Map<string, ThreadMeta>()
  const writes: Array<Promise<void>> = []

  for (const t of threads) {
    const meta = metaOf(t)
    next.set(t.id, meta)
    const key = threadWriteKey(projectId, t.id)
    const prevMeta = prev.get(t.id)
    if (prevMeta === undefined) {
      writes.push(serializedWrite(key, () => api.threads.create(projectId, t)))
    } else if (metaSig(prevMeta) !== metaSig(meta)) {
      const patch = metaPatch(prevMeta, meta)
      writes.push(serializedWrite(key, () => api.threads.updateMeta(projectId, t.id, patch)))
    }
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) {
      writes.push(
        serializedWrite(threadWriteKey(projectId, id), () => api.threads.delete(projectId, id)),
      )
    }
  }

  persistedMeta.set(projectId, next)
  return Promise.all(writes).then(() => undefined)
}

/**
 * Flush a project's current thread metadata to disk. Used when switching away
 * from a project so any debounced metadata changes are committed before its
 * state leaves memory (message content is already appended as it finalizes).
 */
export function flushProjectThreads(
  api: ApiClient,
  projectId: string,
  threads: Thread[],
): Promise<void> {
  return reconcileThreads(api, projectId, threads)
}

/** Test-only: clear the per-project metadata baseline and write chains. */
export function __resetPersistenceForTest(): void {
  persistedMeta.clear()
  writeChains.clear()
  activeAutosave = null
}

export async function loadProjects(
  api: ApiClient,
): Promise<{ projects: Project[]; activeProjectId: string | null }> {
  const projects = recordArrayOrEmpty(await api.storage.get(KEY_PROJECTS)).flatMap((value) => {
    const id = value['id']
    const path = value['path']
    const name = value['name']
    if (typeof id !== 'string' || typeof path !== 'string' || typeof name !== 'string') return []
    const project: Project = { id, path, name }
    if (typeof value['sshHost'] === 'string') project.sshHost = value['sshHost']
    if (typeof value['missing'] === 'boolean') project.missing = value['missing']
    const worktreeMode = value['worktreeMode']
    // `from-default-branch` predates cutting worktrees from the default branch
    // unconditionally; it now means the same thing as `always`.
    if (worktreeMode === 'never' || worktreeMode === 'always') {
      project.worktreeMode = worktreeMode
    } else if (worktreeMode === 'from-default-branch') {
      project.worktreeMode = 'always'
    }
    return [project]
  })
  const rawActiveProjectId = await api.storage.get(KEY_ACTIVE)
  const activeProjectId = typeof rawActiveProjectId === 'string' ? rawActiveProjectId : null
  return { projects, activeProjectId }
}

export async function saveProjects(
  api: ApiClient,
  projects: Project[],
  activeProjectId: string | null,
): Promise<void> {
  await Promise.all([
    serializedSet(api, KEY_PROJECTS, projects),
    serializedSet(api, KEY_ACTIVE, activeProjectId),
  ])
}

export async function loadThreads(api: ApiClient, projectId: string): Promise<Thread[]> {
  const threads = sortThreadsNewestFirst(await api.threads.loadProject(projectId))
  // Seed the persisted-metadata baseline so the autosave doesn't re-create these
  // (they're already on disk) but still detects later deletions and removed keys.
  const metas = new Map<string, ThreadMeta>()
  for (const t of threads) metas.set(t.id, metaOf(t))
  persistedMeta.set(projectId, metas)
  return threads
}

export const AUTOSAVE_DEBOUNCE_MS = 250

export interface Autosave {
  /** Persist any pending changes immediately and await the writes. */
  flush(): Promise<void>
  /**
   * Await in-flight thread writes without forcing a projects save.
   * Settles even when a write rejects so callers can still proceed.
   */
  whenIdle(): Promise<void>
  /** Remove listeners and cancel the pending timer (mainly for tests). */
  detach(): void
}

/** Active autosave from the most recent `attachAutosave` (cleared on detach). */
let activeAutosave: Autosave | null = null

/**
 * Wait for any in-flight autosave writes (especially immediate `threads:create`
 * on a new id). Used by `terminal:create` so main's ownership check cannot race
 * ahead of the create that `threads_changed` already kicked off.
 */
export function awaitPendingThreadPersistence(): Promise<void> {
  return activeAutosave?.whenIdle() ?? Promise.resolve()
}

// Autosave: maps store mutations onto event-level thread-store writes.
//
// - Metadata changes (draft, usage, status, todos, title, branch, structural
//   create/delete) schedule a debounced `reconcile`: it diffs each thread's
//   current metadata signature against the last-persisted one and emits exactly
//   `create` (new id), `updateMeta` (changed meta), or `delete` (removed id).
// - Finalized messages persist immediately via `appendMessage` (the commit
//   point), preceded by a `reconcile` on the same per-thread queue so a
//   brand-new thread's `create` lands before its first append.
//
// Stale-save protection: every write resolves the active project / thread from
// current state at fire time. A late `message_done` from a thread that is gone
// after a project switch finds no thread and writes nothing; `reconcile` only
// ever runs against the active project's own baseline.
export function attachAutosave(store: AppStore, api: ApiClient): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let projectsDirty = false
  // Immediate new-thread creates (and other flushNow work) must be awaitable from
  // flush()/pagehide so callers do not observe a resolved flush while create is
  // still in flight.
  let inflightFlush: Promise<void> = Promise.resolve()

  const reconcile = (projectId: string): Promise<void> =>
    reconcileThreads(api, projectId, store.getState().threads)

  // Persist one message immediately. Reconcile first (same per-thread queue) so a
  // not-yet-created thread is created before its message is appended.
  const persistMessage = (projectId: string, threadId: string, messageId: string): void => {
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const message = thread?.messages.find((m) => m.id === messageId)
    if (!message) return
    void reconcile(projectId)
    void serializedWrite(threadWriteKey(projectId, threadId), () =>
      api.threads.appendMessage(projectId, threadId, message),
    )
  }

  const threadIdOfMessage = (messageId: string): string | undefined => {
    const { threads, activeThreadId } = store.getState()
    const active = threads.find((t) => t.id === activeThreadId)
    if (active?.messages.some((m) => m.id === messageId)) return active.id
    // Skip threads whose transcript is not in memory: their empty `messages`
    // proves nothing, and matching against it would silently attribute the
    // message to the wrong thread or to none. Anything actually streaming a
    // message has been hydrated first (see `ensureThreadMessages` callers).
    return threads.find(
      (t) => t.messagesLoaded !== false && t.messages.some((m) => m.id === messageId),
    )?.id
  }

  const flushNow = (): Promise<void> => {
    const { activeProjectId, projects } = store.getState()
    const writes: Array<Promise<void>> = []
    if (projectsDirty) {
      projectsDirty = false
      writes.push(saveProjects(api, projects, activeProjectId))
    }
    if (activeProjectId) writes.push(reconcile(activeProjectId))
    const done = Promise.all(writes).then(() => undefined)
    inflightFlush = Promise.all([inflightFlush.catch(() => undefined), done]).then(() => undefined)
    return done
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flushNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    projectsDirty = true
    return flushNow().then(() => inflightFlush)
  }

  const unsubscribes = [
    store.on('threads_changed', () => {
      const { activeProjectId, threads } = store.getState()
      if (!activeProjectId) {
        schedule()
        return
      }
      // Blank-thread first send calls `agent:prepareCheckout` before any
      // `message_added` reconcile. Debouncing that create leaves a race that
      // surfaces as "Thread is not persisted yet; retry sending the message".
      // The integrated terminal has the same race on `terminal:create` when a
      // new thread is opened with the Terminal pane already visible.
      // Flush immediately when threads_changed introduces a new id so main can
      // validate the project/thread pair; callers that need the create on disk
      // (send, terminal spawn) must still `awaitPendingThreadPersistence()`.
      const prev = persistedMeta.get(activeProjectId) ?? new Map()
      if (threads.some((t) => !prev.has(t.id))) {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        void flushNow()
        return
      }
      schedule()
    }),
    store.on('thread_draft_changed', () => {
      schedule()
    }),
    store.on('usage_updated', () => {
      schedule()
    }),
    store.on('thread_status_changed', () => {
      schedule()
    }),
    store.on('todos_changed', () => {
      schedule()
    }),
    store.on('context_updated', () => {
      schedule()
    }),
    // A dismissed (or landed) comparison changes thread metadata with no other
    // event in flight — e.g. dismissing a failed card on an idle thread — so it
    // needs its own autosave trigger or the card resurrects on reload.
    store.on('comparison_changed', () => {
      schedule()
    }),
    store.on('projects_changed', () => {
      projectsDirty = true
      schedule()
    }),
    store.on('message_added', (threadId, messageId) => {
      const { activeProjectId, threads } = store.getState()
      if (!activeProjectId) return
      const message = threads
        .find((t) => t.id === threadId)
        ?.messages.find((m) => m.id === messageId)
      // User messages are complete when added — persist now. An assistant message
      // is created empty and streamed, so it waits for `message_done`; still
      // reconcile so the thread's create/meta lands.
      if (message?.role === 'user') persistMessage(activeProjectId, threadId, messageId)
      else schedule()
    }),
    store.on('message_done', (messageId) => {
      const { activeProjectId } = store.getState()
      if (!activeProjectId) return
      const threadId = threadIdOfMessage(messageId)
      if (threadId) persistMessage(activeProjectId, threadId, messageId)
    }),
    // ACP agents may patch raw input/output after the turn's message was first
    // finalized (including between-turn background updates). Re-finalize the
    // owning message when that tool settles so events.jsonl + its result blob
    // carry the latest args/response across an app restart. Do not persist a
    // running tool: the v1 spine deliberately has no running status.
    store.on('tool_call_updated', (messageId, toolCallId) => {
      if (!toolCallId) return
      const { activeProjectId, threads } = store.getState()
      if (!activeProjectId) return
      const threadId = threadIdOfMessage(messageId)
      const message = threads
        .find((thread) => thread.id === threadId)
        ?.messages.find((candidate) => candidate.id === messageId)
      const toolCall = message?.toolCalls.find((candidate) => candidate.id === toolCallId)
      if (!threadId || !toolCall || toolCall.status === 'running') return
      persistMessage(activeProjectId, threadId, messageId)
    }),
  ]

  const onPagehide = (): void => void flush()
  window.addEventListener('pagehide', onPagehide)

  const whenIdle = (): Promise<void> => inflightFlush.catch(() => undefined)

  const autosave: Autosave = {
    flush,
    whenIdle,
    detach(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribes.forEach((u) => {
        u()
      })
      window.removeEventListener('pagehide', onPagehide)
      if (activeAutosave === autosave) activeAutosave = null
    },
  }
  activeAutosave = autosave
  return autosave
}
