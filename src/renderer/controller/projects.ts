import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, Thread } from '@shared/types'
import { createThread, normalizeBlankThreads, switchThread } from '@shared/store/thread-helpers.ts'
import { loadThreads, flushProjectThreads, saveProjects } from './persistence.ts'
import { resumePendingQueues } from './message-queue.ts'
import {
  captureProjectViewState,
  forgetProjectViewState,
  recordProjectViewState,
  resolveProjectViewState,
  type ProjectViewStateRegistry,
} from './project-view-state.ts'

const uuid = (): string => globalThis.crypto.randomUUID()
const basename = (p: string): string => p.split('/').pop() ?? p

/** Dedup key for local and SSH projects. */
export function projectDedupKey(sshHost: string | undefined, path: string): string {
  return `${sshHost ?? ''}\0${path}`
}

function findProjectByKey(
  projects: Project[],
  sshHost: string | undefined,
  path: string,
): Project | undefined {
  const key = projectDedupKey(sshHost, path)
  return projects.find((p) => projectDedupKey(p.sshHost, p.path) === key)
}

async function ensureSshConnected(api: ApiClient, hostId: string): Promise<void> {
  const states = await api.sshWorkspace.getStates()
  const state = states.find((s) => s.hostId === hostId)
  if (state?.status === 'connected') return
  await api.sshWorkspace.connect(hostId)
}

export const SIDEBAR_THREADS_PAGE_SIZE = 10

export interface SidebarThreadPagination {
  visibleThreads: Thread[]
  visibleCount: number
  hasMore: boolean
}

/** Limit sidebar thread rows; expand the window when the active thread falls outside it. */
export function paginateSidebarThreads(
  threads: Thread[],
  visibleLimit: number,
  activeThreadId: string | null | undefined,
): SidebarThreadPagination {
  const total = threads.length
  let visibleCount = Math.min(visibleLimit, total)

  if (activeThreadId) {
    const index = threads.findIndex((t) => t.id === activeThreadId)
    if (index >= visibleCount) {
      visibleCount = Math.min(
        Math.ceil((index + 1) / SIDEBAR_THREADS_PAGE_SIZE) * SIDEBAR_THREADS_PAGE_SIZE,
        total,
      )
    }
  }

  return {
    visibleThreads: threads.slice(0, visibleCount),
    visibleCount,
    hasMore: visibleCount < total,
  }
}

/** In-memory thread lists for sidebar display before a workspace switch finishes. */
const threadCache = new Map<string, Thread[]>()
/** Per-project right-panel view state, so switching projects restores panel visibility. */
const projectViewState: ProjectViewStateRegistry = new Map()
let switchGeneration = 0
let pendingThreadAfterSwitch: string | null = null

type ActivationWaiter = { resolve: () => void; reject: (err: Error) => void }
const activationWaiters = new Map<string, ActivationWaiter>()

function settleActivationWaiter(projectId: string, error?: Error): void {
  const waiter = activationWaiters.get(projectId)
  if (!waiter) return
  activationWaiters.delete(projectId)
  if (error) waiter.reject(error)
  else waiter.resolve()
}

export function getSidebarThreads(store: AppStore, projectId: string): Thread[] {
  const { activeProjectId, threads } = store.getState()
  if (projectId === activeProjectId) return threads
  return threadCache.get(projectId) ?? []
}

export function isProjectSwitchInFlight(store: AppStore, projectId: string): boolean {
  const { activeProjectId, expandedProjectId } = store.getState()
  return expandedProjectId === projectId && activeProjectId !== projectId
}

function cacheThreads(projectId: string, threads: Thread[]): void {
  threadCache.set(projectId, threads)
}

/** Keep the sidebar cache aligned with the active workspace thread list. */
export function attachProjectThreadCache(store: AppStore): () => void {
  return store.on('threads_changed', () => {
    const { activeProjectId, threads } = store.getState()
    if (activeProjectId) cacheThreads(activeProjectId, threads)
  })
}

async function trySetWorkspace(api: ApiClient, path: string): Promise<boolean> {
  try {
    await api.workspace.set(path)
    return true
  } catch {
    return false
  }
}

function abortProjectActivation(
  store: AppStore,
  id: string,
  gen: number,
  outgoingId: string | null,
  error: Error,
): void {
  if (gen !== switchGeneration) return
  settleActivationWaiter(id, error)
  const revertExpanded = outgoingId ?? store.getState().activeProjectId
  if (revertExpanded) {
    store.setState({ expandedProjectId: revertExpanded })
  }
  store.emit('projects_changed')
  store.emit('workspace_changed')
}

async function dropMissingProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  forgetProjectViewState(projectViewState, id)
  const projects = store.getState().projects.filter((p) => p.id !== id)
  const nextActiveId = projects[0]?.id ?? null
  await saveProjects(api, projects, nextActiveId)
  store.setState({
    projects,
    activeProjectId: nextActiveId,
    expandedProjectId: nextActiveId,
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

function setExpandedProject(store: AppStore, id: string): void {
  store.setState({ expandedProjectId: id })
}

function expandProject(store: AppStore, id: string): void {
  setExpandedProject(store, id)
  store.emit('projects_changed')
}

async function finishActivate(
  store: AppStore,
  api: ApiClient,
  id: string,
  path: string,
  sshHost: string | undefined,
  gen: number,
  outgoingId: string | null,
  outgoingThreads: Thread[],
): Promise<void> {
  if (gen !== switchGeneration) return

  if (outgoingId && outgoingId !== id) {
    await flushProjectThreads(api, outgoingId, outgoingThreads)
  }
  if (gen !== switchGeneration) return

  await saveProjects(api, store.getState().projects, id)
  if (gen !== switchGeneration) return

  if (sshHost) {
    const enabled = await api.settings.get('sshWorkspaceEnabled')
    if (enabled !== true) {
      abortProjectActivation(
        store,
        id,
        gen,
        outgoingId,
        new Error('Enable SSH workspaces in Settings before opening a remote folder.'),
      )
      return
    }
    try {
      await ensureSshConnected(api, sshHost)
    } catch (err) {
      if (gen !== switchGeneration) return
      const message = err instanceof Error ? err.message : String(err)
      abortProjectActivation(
        store,
        id,
        gen,
        outgoingId,
        new Error(`SSH connection failed: ${message}`),
      )
      return
    }
  }

  if (!(await trySetWorkspace(api, path))) {
    if (gen !== switchGeneration) return
    if (sshHost) {
      abortProjectActivation(
        store,
        id,
        gen,
        outgoingId,
        new Error('Could not open the remote workspace folder.'),
      )
      return
    }
    await dropMissingProject(store, api, id)
    return
  }
  if (gen !== switchGeneration) return

  const loaded = await loadThreads(api, id)
  cacheThreads(id, loaded)
  if (gen !== switchGeneration) return
  if (store.getState().expandedProjectId !== id) return

  const pendingThreadId = pendingThreadAfterSwitch
  pendingThreadAfterSwitch = null
  const activeThreadId =
    pendingThreadId && loaded.some((t) => t.id === pendingThreadId)
      ? pendingThreadId
      : (loaded[0]?.id ?? null)

  const view = resolveProjectViewState(projectViewState, id)
  store.setState({
    activeProjectId: id,
    expandedProjectId: id,
    workspaceRoot: path,
    threads: loaded,
    activeThreadId,
    openFile: null,
    panelTab: view.panelTab,
    filesPaneOpen: view.filesPaneOpen,
    rightPanelMode: view.rightPanelMode,
  })
  if (loaded.length === 0) createThread(store)
  else normalizeBlankThreads(store)

  await saveProjects(api, store.getState().projects, id)
  store.emit('projects_changed')
  store.emit('workspace_changed')
  store.emit('threads_changed')
  store.emit('panel_changed')
  store.emit('files_pane_changed')
  settleActivationWaiter(id)
  resumePendingQueues(store, api)
}

// Core project switch: expand the sidebar immediately, then persist threads,
// point the workspace at the new path, and load threads in the background.
function activate(
  store: AppStore,
  api: ApiClient,
  id: string,
  path: string,
  sshHost?: string,
): void {
  const { activeProjectId, threads, expandedProjectId } = store.getState()
  if (activeProjectId === id && (expandedProjectId ?? activeProjectId) === id) return

  expandProject(store, id)
  if (activeProjectId === id) return

  const gen = ++switchGeneration
  const outgoingId = activeProjectId
  const outgoingThreads = threads
  if (outgoingId) {
    cacheThreads(outgoingId, outgoingThreads)
    // Snapshot the outgoing project's panel visibility so switching back restores it.
    recordProjectViewState(projectViewState, outgoingId, captureProjectViewState(store.getState()))
  }

  void finishActivate(store, api, id, path, sshHost, gen, outgoingId, outgoingThreads)
}

export function switchProject(store: AppStore, api: ApiClient, id: string): void {
  const proj = store.getState().projects.find((p) => p.id === id)
  if (!proj) return
  activate(store, api, id, proj.path, proj.sshHost)
}

export function switchProjectThread(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
): void {
  const { activeProjectId } = store.getState()
  if (projectId === activeProjectId) {
    switchThread(store, threadId)
    return
  }
  pendingThreadAfterSwitch = threadId
  switchProject(store, api, projectId)
}

// Register a folder as a project (dedup by path + sshHost) and switch to it.
export async function addProjectFromPath(
  store: AppStore,
  api: ApiClient,
  path: string,
): Promise<void> {
  const existing = findProjectByKey(store.getState().projects, undefined, path)
  let id: string
  if (existing) {
    id = existing.id
  } else {
    id = uuid()
    store.setState({
      projects: [...store.getState().projects, { id, path, name: basename(path) }],
    })
  }
  return activateAndWait(store, api, id, path)
}

export async function addProjectFromRemotePath(
  store: AppStore,
  api: ApiClient,
  hostId: string,
  path: string,
): Promise<void> {
  const enabled = await api.settings.get('sshWorkspaceEnabled')
  if (enabled !== true) {
    throw new Error('Enable SSH workspaces in Settings before opening a remote folder.')
  }
  const canonical = await api.sshWorkspace.registerRoot(hostId, path)
  const existing = findProjectByKey(store.getState().projects, hostId, canonical)
  let id: string
  if (existing) {
    id = existing.id
  } else {
    id = uuid()
    const hosts = await api.sshWorkspace.listHosts()
    const host = hosts.find((h) => h.id === hostId)
    const label = host?.label ?? hostId
    store.setState({
      projects: [
        ...store.getState().projects,
        { id, path: canonical, name: `${label}:${basename(canonical)}`, sshHost: hostId },
      ],
    })
  }
  return activateAndWait(store, api, id, canonical, hostId)
}

function activateAndWait(
  store: AppStore,
  api: ApiClient,
  id: string,
  path: string,
  sshHost?: string,
): Promise<void> {
  activate(store, api, id, path, sshHost)
  return waitForProjectActivation(store, id)
}

async function waitForProjectActivation(store: AppStore, projectId: string): Promise<void> {
  if (store.getState().activeProjectId === projectId) return
  await new Promise<void>((resolve, reject) => {
    activationWaiters.set(projectId, { resolve, reject })
    const unsub = store.on('workspace_changed', () => {
      if (store.getState().activeProjectId === projectId) {
        activationWaiters.delete(projectId)
        unsub()
        resolve()
      }
    })
  })
}

// Restore a project on launch without re-creating threads it already has.
export async function restoreProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  const proj = store.getState().projects.find((p) => p.id === id)
  if (!proj) return
  if (proj.sshHost) {
    const enabled = await api.settings.get('sshWorkspaceEnabled')
    if (enabled !== true) return
    try {
      await ensureSshConnected(api, proj.sshHost)
    } catch {
      return
    }
  }
  if (!(await trySetWorkspace(api, proj.path))) {
    await dropMissingProject(store, api, id)
    const nextProjectId = store.getState().activeProjectId
    if (nextProjectId) {
      await restoreProject(store, api, nextProjectId)
    }
    return
  }
  const loaded = await loadThreads(api, id)
  cacheThreads(id, loaded)
  store.setState({
    activeProjectId: id,
    expandedProjectId: id,
    workspaceRoot: proj.path,
    threads: loaded,
    activeThreadId: loaded[0]?.id ?? null,
  })
  if (loaded.length === 0) createThread(store)
  else normalizeBlankThreads(store)
  store.emit('projects_changed')
  store.emit('workspace_changed')
  store.emit('threads_changed')
  resumePendingQueues(store, api)
}

export async function addProject(store: AppStore, api: ApiClient): Promise<boolean> {
  const path = await api.workspace.open()
  if (!path) return false
  await addProjectFromPath(store, api, path)
  return true
}

export async function addRemoteProject(store: AppStore, api: ApiClient): Promise<boolean> {
  const { openRemoteFolderDialog } = await import('../views/remote-folder-dialog.ts')
  const picked = await openRemoteFolderDialog(api)
  if (!picked) return false
  await addProjectFromRemotePath(store, api, picked.hostId, picked.path)
  return true
}

/** Test hook — reset module-level switch state. */
export function resetProjectSwitchStateForTest(): void {
  switchGeneration = 0
  pendingThreadAfterSwitch = null
  threadCache.clear()
  projectViewState.clear()
  activationWaiters.clear()
}

/** Test hook — seed sidebar thread cache for a project. */
export function setThreadCacheForTest(projectId: string, threads: Thread[]): void {
  threadCache.set(projectId, threads)
}
