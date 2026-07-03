import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'

// On-disk persistence for projects and their chat threads. Projects stay in the
// shared electron-store (config.json); each thread is a separate JSON file under
// userData/threads/<projectId>/ so draft keystrokes only rewrite one small file
// instead of the whole project's thread history.

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

function serializedThreadWrite(key: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(write)
  writeChains.set(key, next)
  void next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key)
  })
  return next
}

const threadWriteKey = (projectId: string, threadId: string): string =>
  `thread:${projectId}:${threadId}`
const projectWriteKey = (projectId: string): string => `threads-project:${projectId}`

export async function loadProjects(
  api: ApiClient,
): Promise<{ projects: Project[]; activeProjectId: string | null }> {
  const projects = (await api.storage.get(KEY_PROJECTS)) as Project[] | null
  const activeProjectId = (await api.storage.get(KEY_ACTIVE)) as string | null
  return { projects: projects ?? [], activeProjectId: activeProjectId ?? null }
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
  const threads = await api.threads.loadProject(projectId)
  return sortThreadsNewestFirst(threads)
}

export async function saveThread(api: ApiClient, projectId: string, thread: Thread): Promise<void> {
  await serializedThreadWrite(threadWriteKey(projectId, thread.id), () =>
    api.threads.saveOne(projectId, thread),
  )
}

export async function saveThreads(
  api: ApiClient,
  projectId: string,
  threads: Thread[],
): Promise<void> {
  await serializedThreadWrite(projectWriteKey(projectId), () =>
    api.threads.saveProject(projectId, threads),
  )
}

export const AUTOSAVE_DEBOUNCE_MS = 250

export interface Autosave {
  /** Persist any pending changes immediately and await the writes. */
  flush(): Promise<void>
  /** Remove listeners and cancel the pending timer (mainly for tests). */
  detach(): void
}

interface PendingAutosave {
  projects: boolean
  fullThreads: boolean
  threadIds: Set<string>
}

function emptyPending(): PendingAutosave {
  return { projects: false, fullThreads: false, threadIds: new Set() }
}

// Autosave: persists the active project's threads (and the project list) on
// meaningful changes. Draft keystrokes only rewrite the one changed thread file;
// structural thread list changes still save the whole project.
//
// Stale-save protection: the save reads the *current* active project at flush
// time and writes that project's threads under that project's key. A late
// `message_done`/`usage_updated` from an outgoing thread that arrives after a
// project switch only schedules another debounced save, which then re-reads the
// now-current state — it can never write the outgoing thread's data under the
// new project's key.
export function attachAutosave(store: AppStore, api: ApiClient): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = emptyPending()

  const writeNow = (): Promise<void> => {
    const snapshot = pending
    pending = emptyPending()

    const { activeProjectId, threads, projects } = store.getState()
    const writes: Array<Promise<void>> = []

    if (snapshot.projects) {
      writes.push(saveProjects(api, projects, activeProjectId))
    }

    if (activeProjectId) {
      if (snapshot.fullThreads) {
        writes.push(saveThreads(api, activeProjectId, threads))
      } else {
        for (const threadId of snapshot.threadIds) {
          const thread = threads.find((t) => t.id === threadId)
          if (thread) writes.push(saveThread(api, activeProjectId, thread))
        }
      }
    }

    return Promise.all(writes).then(() => undefined)
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending.projects = true
    pending.fullThreads = true
    pending.threadIds.clear()
    return writeNow()
  }

  const scheduleSave = (patch: Partial<PendingAutosave> & { threadId?: string }): void => {
    if (patch.projects) pending.projects = true
    if (patch.fullThreads) pending.fullThreads = true
    if (patch.threadId) pending.threadIds.add(patch.threadId)
    if (patch.threadIds) {
      for (const id of patch.threadIds) pending.threadIds.add(id)
    }

    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void writeNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const unsubscribes = [
    store.on('threads_changed', () => {
      scheduleSave({ projects: true, fullThreads: true })
    }),
    store.on('thread_draft_changed', (threadId) => {
      scheduleSave({ threadId })
    }),
    store.on('message_done', () => {
      const { activeThreadId } = store.getState()
      if (activeThreadId) scheduleSave({ threadId: activeThreadId })
    }),
    store.on('usage_updated', (threadId) => {
      scheduleSave({ threadId })
    }),
    store.on('thread_status_changed', (threadId) => {
      scheduleSave({ threadId })
    }),
    store.on('projects_changed', () => {
      scheduleSave({ projects: true })
    }),
    store.on('todos_changed', (threadId) => {
      scheduleSave({ threadId })
    }),
  ]

  const onPagehide = (): void => void flush()
  window.addEventListener('pagehide', onPagehide)

  return {
    flush,
    detach(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = emptyPending()
      unsubscribes.forEach((u) => {
        u()
      })
      window.removeEventListener('pagehide', onPagehide)
    },
  }
}
