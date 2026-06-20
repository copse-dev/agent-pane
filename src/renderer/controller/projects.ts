import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import { loadThreads, saveThreads, saveProjects } from './persistence.ts'

const uuid = () => globalThis.crypto.randomUUID()
const basename = (p: string) => p.split('/').pop() ?? p

// Core project switch: persist the outgoing project's threads, point the
// workspace at the new path, load the new project's threads, and broadcast the
// changes so every pane re-renders.
async function activate(store: AppStore, api: ApiClient, id: string, path: string): Promise<void> {
  const { activeProjectId, threads } = store.getState()
  if (activeProjectId && activeProjectId !== id) {
    await saveThreads(api, activeProjectId, threads)
  }
  await api.workspace.set(path)
  const loaded = await loadThreads(api, id)
  store.setState({
    activeProjectId: id,
    workspaceRoot: path,
    threads: loaded,
    activeThreadId: loaded[0]?.id ?? null,
    openFile: null,
    panelTab: 'file',
    filesPaneOpen: false,
  })
  if (loaded.length === 0) createThread(store)
  await saveProjects(api, store.getState().projects, id)
  store.emit('projects_changed')
  store.emit('workspace_changed')
  store.emit('threads_changed')
  store.emit('panel_changed')
  store.emit('files_pane_changed')
}

export async function switchProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  if (id === store.getState().activeProjectId) return
  const proj = store.getState().projects.find((p) => p.id === id)
  if (!proj) return
  await activate(store, api, id, proj.path)
}

// Register a folder as a project (dedup by path) and switch to it.
export async function addProjectFromPath(
  store: AppStore,
  api: ApiClient,
  path: string,
): Promise<void> {
  const existing = store.getState().projects.find((p) => p.path === path)
  let id: string
  if (existing) {
    id = existing.id
  } else {
    id = uuid()
    store.setState({ projects: [...store.getState().projects, { id, path, name: basename(path) }] })
  }
  await activate(store, api, id, path)
}

// Restore a project on launch without re-creating threads it already has.
export async function restoreProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  const proj = store.getState().projects.find((p) => p.id === id)
  if (!proj) return
  await api.workspace.set(proj.path)
  const loaded = await loadThreads(api, id)
  store.setState({
    activeProjectId: id,
    workspaceRoot: proj.path,
    threads: loaded,
    activeThreadId: loaded[0]?.id ?? null,
  })
  if (loaded.length === 0) createThread(store)
  store.emit('workspace_changed')
  store.emit('threads_changed')
}

export async function addProject(store: AppStore, api: ApiClient): Promise<boolean> {
  const path = await api.workspace.open()
  if (!path) return false
  await addProjectFromPath(store, api, path)
  return true
}
