import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread } from '@shared/types'

// On-disk persistence for projects and their chat threads, via the main-process
// electron-store (storage:get/set IPC). Threads are stored per project so
// switching projects loads only that project's history.

const KEY_PROJECTS = 'projects'
const KEY_ACTIVE = 'activeProjectId'
const threadsKey = (projectId: string) => `threads:${projectId}`

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
  return threads ?? []
}

export async function saveThreads(
  api: ApiClient,
  projectId: string,
  threads: Thread[],
): Promise<void> {
  await serializedSet(api, threadsKey(projectId), threads)
}

// Autosave: persists the active project's threads (and the project list) on
// every meaningful change. These events fire at most a few times per turn (not
// per token), so saving immediately — rather than debouncing — avoids losing
// the latest message if the app is closed right after a reply.
export function attachAutosave(store: AppStore, api: ApiClient): void {
  const save = () => {
    const { activeProjectId, threads, projects } = store.getState()
    if (activeProjectId) void saveThreads(api, activeProjectId, threads)
    void saveProjects(api, projects, activeProjectId)
  }
  const events = [
    'threads_changed',
    'message_done',
    'usage_updated',
    'thread_status_changed',
    'projects_changed',
    'todos_changed',
  ] as const
  events.forEach((e) => store.on(e, save))

  // Safety net: flush once more as the window is torn down.
  window.addEventListener('pagehide', save)
}
