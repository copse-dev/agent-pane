import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'

// On-disk persistence for projects and their chat threads, via the main-process
// electron-store (storage:get/set IPC). Threads are stored per project so
// switching projects loads only that project's history.

const KEY_PROJECTS = 'projects'
const KEY_ACTIVE = 'activeProjectId'
const threadsKey = (projectId: string): string => `threads:${projectId}`

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
  const threads = (await api.storage.get(threadsKey(projectId))) as Thread[] | null
  return threads ? sortThreadsNewestFirst(threads) : []
}

export async function saveThreads(
  api: ApiClient,
  projectId: string,
  threads: Thread[],
): Promise<void> {
  await serializedSet(api, threadsKey(projectId), threads)
}

export const AUTOSAVE_DEBOUNCE_MS = 250

export interface Autosave {
  /** Persist any pending changes immediately and await the writes. */
  flush(): Promise<void>
  /** Remove listeners and cancel the pending timer (mainly for tests). */
  detach(): void
}

// Autosave: persists the active project's threads (and the project list) on
// every meaningful change. Several events fire per turn, so writes are debounced
// to coalesce a burst into one save instead of issuing redundant writes.
//
// Stale-save protection: the save reads the *current* active project at flush
// time and writes that project's threads under that project's key. A late
// `message_done`/`usage_updated` from an outgoing thread that arrives after a
// project switch only schedules another debounced save, which then re-reads the
// now-current state — it can never write the outgoing thread's data under the
// new project's key. (Per-key write chaining in `serializedSet` additionally
// guarantees writes to a given key apply in submission order.)
export function attachAutosave(store: AppStore, api: ApiClient): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null

  const writeNow = (): Promise<void> => {
    const { activeProjectId, threads, projects } = store.getState()
    const writes: Array<Promise<void>> = [saveProjects(api, projects, activeProjectId)]
    if (activeProjectId) writes.push(saveThreads(api, activeProjectId, threads))
    return Promise.all(writes).then(() => undefined)
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return writeNow()
  }

  const scheduleSave = (): void => {
    if (timer !== null) return // a save is already pending; coalesce into it
    timer = setTimeout(() => {
      timer = null
      void writeNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const events = [
    'threads_changed',
    'thread_draft_changed',
    'message_done',
    'usage_updated',
    'thread_status_changed',
    'projects_changed',
    'todos_changed',
  ] as const
  const unsubscribes = events.map((e) => store.on(e, scheduleSave))

  // Safety net on window teardown. `pagehide` can't await an async callback, but
  // electron-store IPC is dispatched synchronously when the call is made, so
  // kicking the (debounced) write here — bypassing the timer via flush() — gives
  // the final save the best chance to be delivered before the window dies.
  const onPagehide = (): void => void flush()
  window.addEventListener('pagehide', onPagehide)

  return {
    flush,
    detach(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribes.forEach((u) => {
        u()
      })
      window.removeEventListener('pagehide', onPagehide)
    },
  }
}
