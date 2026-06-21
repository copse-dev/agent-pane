import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createThread, normalizeBlankThreads } from '@shared/store/thread-helpers.ts'
import { loadThreads, saveThreads, saveProjects } from './persistence.ts'

const uuid = () => globalThis.crypto.randomUUID()
const basename = (p: string) => p.split('/').pop() ?? p

async function trySetWorkspace(api: ApiClient, path: string): Promise<boolean> {
  try {
    await api.workspace.set(path)
    return true
  } catch {
    return false
  }
}

async function dropMissingProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  const projects = store.getState().projects.filter((p) => p.id !== id)
  const nextActiveId = projects[0]?.id ?? null
  await saveProjects(api, projects, nextActiveId)
  store.setState({
    projects,
    activeProjectId: nextActiveId,
    workspaceRoot: null,
    threads: [],
    activeThreadId: null,
    openFile: null,
    filesPaneOpen: false,
  })
  store.emit('projects_changed')
  store.emit('workspace_changed')
  store.emit('threads_changed')
  store.emit('panel_changed')
  store.emit('files_pane_changed')
}

// Core project switch: persist the outgoing project's threads, point the
// workspace at the new path, load the new project's threads, and broadcast the
// changes so every pane re-renders.
async function activate(store: AppStore, api: ApiClient, id: string, path: string): Promise<void> {
  const { activeProjectId, threads } = store.getState()
  if (activeProjectId && activeProjectId !== id) {
    await saveThreads(api, activeProjectId, threads)
  }
  await saveProjects(api, store.getState().projects, id)
  if (!(await trySetWorkspace(api, path))) {
    await dropMissingProject(store, api, id)
    return
  }
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
  else normalizeBlankThreads(store)
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
  if (!(await trySetWorkspace(api, proj.path))) {
    await dropMissingProject(store, api, id)
    if (store.getState().activeProjectId) {
      await restoreProject(store, api, store.getState().activeProjectId!)
    }
    return
  }
  const loaded = await loadThreads(api, id)
  store.setState({
    activeProjectId: id,
    workspaceRoot: proj.path,
    threads: loaded,
    activeThreadId: loaded[0]?.id ?? null,
  })
  if (loaded.length === 0) createThread(store)
  else normalizeBlankThreads(store)
  store.emit('workspace_changed')
  store.emit('threads_changed')
}

export async function addProject(store: AppStore, api: ApiClient): Promise<boolean> {
  const path = await api.workspace.open()
  if (!path) return false
  await addProjectFromPath(store, api, path)
  return true
}
