import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { OrphanProjectStore, Project, Thread } from '@shared/types'
import {
  createThread,
  normalizeBlankThreads,
  setThreadDraftPrompt,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { loadThreads, flushProjectThreads, saveProjects } from './persistence.ts'
import { resumePendingQueues } from './message-queue.ts'
import {
  captureProjectViewState,
  forgetProjectViewState,
  recordProjectViewState,
  resolveProjectViewState,
  type ProjectViewStateRegistry,
} from './project-view-state.ts'
import { showErrorToast } from '../views/toast.ts'
import { compactSidebarThread, type SidebarThread } from './sidebar-thread.ts'

const uuid = (): string => globalThis.crypto.randomUUID()
const basename = (p: string): string => p.split('/').pop() ?? p

/** Sidebar / stored name for an SSH project — host label plus full remote path. */
export function formatSshProjectName(hostLabel: string, remotePath: string): string {
  return `${hostLabel}:${remotePath}`
}

/**
 * Label shown in the projects sidebar. SSH projects always include the remote
 * path so two folders that share a basename (e.g. `/etc/ddg` vs `/opt/ddg`)
 * do not both render as `host:ddg`.
 */
export function projectDisplayName(project: Project): string {
  if (!project.sshHost) return project.name
  const colon = project.name.indexOf(':')
  const label = colon > 0 ? project.name.slice(0, colon) : project.sshHost
  return formatSshProjectName(label, project.path)
}

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
  visibleThreads: SidebarThread[]
  visibleCount: number
  hasMore: boolean
}

/** Limit sidebar thread rows; expand the window when the active thread falls outside it. */
export function paginateSidebarThreads(
  threads: SidebarThread[],
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

/**
 * In-memory thread lists for sidebar display before a workspace switch finishes.
 *
 * The active project's entry aliases the store's own array, so it costs nothing.
 * Every other entry is compacted (see {@link compactSidebarThread}): a project
 * you have switched away from keeps its sidebar rows but not its transcripts,
 * which is all the sidebar ever read. Nothing else can want them — a non-active
 * project has no threads in the store for a run to stream into, automations bail
 * unless their project is active, and switching back reloads from disk.
 */
const threadCache = new Map<string, SidebarThread[]>()
/** Which project's cache entry is the live alias, and so the one still to compact. */
let liveCacheProjectId: string | null = null
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

export function getSidebarThreads(store: AppStore, projectId: string): SidebarThread[] {
  const { activeProjectId, threads } = store.getState()
  const list = projectId === activeProjectId ? threads : (threadCache.get(projectId) ?? [])
  // Archived threads stay in the project store / on disk but leave the sidebar.
  return list.filter((t) => t.archivedAt == null)
}

export function isProjectSwitchInFlight(store: AppStore, projectId: string): boolean {
  const { activeProjectId, expandedProjectId, workspaceRoot } = store.getState()
  if (expandedProjectId === projectId && activeProjectId !== projectId) return true
  // On launch, activeProjectId is restored from persisted state before
  // restoreProject() finishes opening the workspace and loading its threads
  // (main.ts mounts the panel without waiting for that to complete). Treat
  // that window as in-flight too, so the sidebar shows "Loading…" instead of
  // an empty thread list while a large project's threads load in the background.
  return activeProjectId === projectId && !workspaceRoot
}

function cacheThreads(projectId: string, threads: Thread[]): void {
  // A different project is taking over the live entry — compact the outgoing one
  // so its transcripts stop being reachable from here.
  if (liveCacheProjectId !== null && liveCacheProjectId !== projectId) {
    const outgoing = threadCache.get(liveCacheProjectId)
    if (outgoing) threadCache.set(liveCacheProjectId, outgoing.map(compactSidebarThread))
  }
  liveCacheProjectId = projectId
  threadCache.set(projectId, threads)
}

/** Keep the sidebar cache aligned with the active workspace thread list. */
export function attachProjectThreadCache(store: AppStore): () => void {
  return store.on('threads_changed', () => {
    const { activeProjectId, threads } = store.getState()
    if (activeProjectId) cacheThreads(activeProjectId, threads)
  })
}

async function trySetWorkspace(api: ApiClient, path: string, sshHost?: string): Promise<boolean> {
  try {
    await api.workspace.set(path, sshHost)
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

/** Strip the `missing` flag from a project once its folder opens again. */
function clearMissing(project: Project): Project {
  if (!project.missing) return project
  const { missing: _missing, ...rest } = project
  return rest
}

/** Projects array with `id`'s `missing` flag cleared (identity-stable when unset). */
function projectsWithMissingCleared(projects: Project[], id: string): Project[] {
  if (!projects.some((p) => p.id === id && p.missing)) return projects
  return projects.map((p) => (p.id === id ? clearMissing(p) : p))
}

/**
 * Quarantine a project whose folder could not be opened instead of deleting it.
 * The entry stays in config (flagged `missing`) and its threads stay on disk, so
 * a transient failure — a wedged main process, an unmounted volume, a folder
 * that moved — never silently discards the project and its history (issue #997).
 * The sidebar surfaces it with a relocate action; a later successful open clears
 * the flag. Navigation (advancing the active project, reverting the sidebar) is
 * left to the caller, which differs between launch-restore and manual switch.
 */
async function markProjectMissing(store: AppStore, api: ApiClient, id: string): Promise<void> {
  const projects = store.getState().projects.map((p) => (p.id === id ? { ...p, missing: true } : p))
  store.setState({ projects })
  await saveProjects(api, projects, store.getState().activeProjectId)
  store.emit('projects_changed')
}

/**
 * Remove a project from the sidebar / config only. Does not delete workspace
 * files on disk or the project's thread-store directory under ~/.copse.
 */
export async function removeProject(store: AppStore, api: ApiClient, id: string): Promise<void> {
  const state = store.getState()
  if (!state.projects.some((p) => p.id === id)) return

  forgetProjectViewState(projectViewState, id)
  threadCache.delete(id)
  if (liveCacheProjectId === id) liveCacheProjectId = null

  const projects = state.projects.filter((p) => p.id !== id)
  const wasActive = state.activeProjectId === id
  const wasExpanded = (state.expandedProjectId ?? state.activeProjectId) === id

  if (!wasActive) {
    // Cancel an in-flight switch that was targeting this project.
    if (wasExpanded) switchGeneration += 1
    await saveProjects(api, projects, state.activeProjectId)
    store.setState({
      projects,
      expandedProjectId: wasExpanded ? state.activeProjectId : state.expandedProjectId,
    })
    store.emit('projects_changed')
    return
  }

  // Active project removed — switch to another, or clear the workspace UI.
  switchGeneration += 1
  const next = projects[0] ?? null
  await saveProjects(api, projects, next?.id ?? null)

  if (!next) {
    store.setState({
      projects: [],
      activeProjectId: null,
      expandedProjectId: null,
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
    return
  }

  // Persist the trimmed list first, then activate the next project (which
  // flushes the outgoing active project's threads as part of the switch).
  store.setState({ projects })
  store.emit('projects_changed')
  await activateAndWait(store, api, next.id, next.path, next.sshHost)
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

  if (sshHost) {
    const enabled = await api.settings.get('sshWorkspaceEnabled')
    if (enabled !== true) {
      abortProjectActivation(
        store,
        id,
        gen,
        outgoingId,
        new Error('Enable SSH workspaces in Settings → SSH before opening a remote folder.'),
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

  // These operations touch independent stores. Start them together so dirty
  // outgoing metadata or config I/O does not sit in front of workspace
  // activation. Loading incoming threads still waits for a successful open,
  // avoiding cache/baseline changes for a quarantined project.
  const flushOutgoing =
    outgoingId && outgoingId !== id
      ? flushProjectThreads(api, outgoingId, outgoingThreads)
      : Promise.resolve()
  const persistSelection = saveProjects(api, store.getState().projects, id)
  const workspaceOpened = trySetWorkspace(api, path, sshHost)
  const [, , opened] = await Promise.all([flushOutgoing, persistSelection, workspaceOpened])
  if (gen !== switchGeneration) return

  if (!opened) {
    if (gen !== switchGeneration) return
    // Quarantine rather than delete: flag the project missing and stay on the
    // project the user was already viewing (issue #997).
    await markProjectMissing(store, api, id)
    abortProjectActivation(
      store,
      id,
      gen,
      outgoingId,
      new Error(
        sshHost
          ? 'Could not open the remote workspace folder.'
          : 'Project folder could not be opened — relocate it from the sidebar.',
      ),
    )
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
    // Opening succeeded — lift any prior "folder missing" quarantine (#997).
    projects: projectsWithMissingCleared(store.getState().projects, id),
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
  void resumePendingQueues(store, api)
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
    throw new Error('Enable SSH workspaces in Settings → SSH before opening a remote folder.')
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
        { id, path: canonical, name: formatSshProjectName(label, canonical), sshHost: hostId },
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

async function quarantineAndRestoreNext(
  store: AppStore,
  api: ApiClient,
  id: string,
): Promise<void> {
  await markProjectMissing(store, api, id)
  const next = store.getState().projects.find((p) => p.id !== id && !p.missing)
  if (next) {
    store.setState({ activeProjectId: next.id, expandedProjectId: next.id })
    await restoreProject(store, api, next.id)
    return
  }
  store.setState({
    activeProjectId: null,
    expandedProjectId: null,
    workspaceRoot: null,
    threads: [],
    activeThreadId: null,
  })
  await saveProjects(api, store.getState().projects, null)
  store.emit('workspace_changed')
  store.emit('threads_changed')
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
      // Keep the project active so the SSH disconnect banner (Reconnect) can
      // surface. A down host is not a missing folder — quarantining here would
      // clear activeProjectId and hide that recovery path (#997 / ssh-titlebar).
      return
    }
  }
  // Thread-store reads are project-id scoped and independent from workspace
  // activation. Overlap them on launch; both can scale on an aged profile.
  const [workspaceOpened, loaded] = await Promise.all([
    trySetWorkspace(api, proj.path, proj.sshHost),
    loadThreads(api, id),
  ])
  if (!workspaceOpened) {
    await quarantineAndRestoreNext(store, api, id)
    return
  }
  cacheThreads(id, loaded)
  store.setState({
    activeProjectId: id,
    expandedProjectId: id,
    workspaceRoot: proj.path,
    threads: loaded,
    activeThreadId: loaded[0]?.id ?? null,
    // Opening succeeded — lift any prior quarantine on this project (#997).
    projects: projectsWithMissingCleared(store.getState().projects, id),
  })
  await saveProjects(api, store.getState().projects, id)
  if (loaded.length === 0) createThread(store)
  else normalizeBlankThreads(store)
  store.emit('projects_changed')
  store.emit('workspace_changed')
  store.emit('threads_changed')
  void resumePendingQueues(store, api)
}

// Starter prompt seeded into the composer when a new project is created, so
// the user lands on a "welcome to your new project" message rather than an
// empty box.
const NEW_PROJECT_STARTER_PROMPT =
  'Introduce this project: look at the AGENT.md and README.md, then suggest what we should build first. Prefer plan mode and ask me clarifying questions before making changes.'

/**
 * Scaffold a brand-new project: ask the user for a name and parent directory,
 * create the folder (AGENT.md + README.md + git init) via the main process,
 * register + activate it, then open a fresh thread pre-seeded with a starter
 * prompt. Returns true if a project was created.
 */
export async function createNewProject(store: AppStore, api: ApiClient): Promise<boolean> {
  const { openNewProjectDialog } = await import('../views/new-project-dialog.ts')
  const inferred = lastProjectDirectory(store)
  const home = await api.workspace.getHomeDirectory()
  const parentDir = inferred !== '' ? inferred : home
  const picked = await openNewProjectDialog(api, parentDir)
  if (!picked) return false
  // Scaffolding rejects on ordinary user mistakes ("Folder already exists and is
  // not empty", an unwritable parent), and every call site fires this as a
  // floating promise — without this the dialog just closes and nothing happens.
  let root: string
  try {
    root = await api.workspace.createNewProject(picked.name, picked.parentDir)
  } catch (err: unknown) {
    showErrorToast('Could not create project', err)
    return false
  }
  await addProjectFromPath(store, api, root)
  // Activation creates a blank thread when the project has none; seed that new
  // thread (or, if one already existed, the active one) with the starter prompt.
  const state = store.getState()
  const threadId = state.activeThreadId ?? createThread(store)
  setThreadDraftPrompt(store, threadId, NEW_PROJECT_STARTER_PROMPT)
  return true
}

/** Parent directory of the most recently created/opened local project, else home. */
function lastProjectDirectory(store: AppStore): string {
  const projects = store.getState().projects
  const last = projects[projects.length - 1]
  if (last && !last.sshHost && last.path) {
    const slash = last.path.lastIndexOf('/')
    if (slash > 0) return last.path.slice(0, slash)
  }
  return ''
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

/**
 * Re-point a quarantined (or any) local project at a freshly chosen folder and
 * open it. The project id is unchanged, so its threads under
 * `~/.copse/workspace/<id>/` stay attached — only the path changes and the
 * `missing` flag is cleared (issue #997). Returns false if the picker is
 * cancelled or the project is unknown.
 */
export async function relocateProject(
  store: AppStore,
  api: ApiClient,
  id: string,
): Promise<boolean> {
  const proj = store.getState().projects.find((p) => p.id === id)
  if (!proj || proj.sshHost) return false
  const path = await api.workspace.open()
  if (!path) return false
  const projects = store
    .getState()
    .projects.map((p) => (p.id === id ? clearMissing({ ...p, path }) : p))
  store.setState({ projects })
  store.emit('projects_changed')
  await activateAndWait(store, api, id, path)
  return true
}

/** Store dirs with threads but no project entry — orphans to re-attach (#997). */
export function listOrphanProjects(api: ApiClient): Promise<OrphanProjectStore[]> {
  return api.threads.listOrphans()
}

/**
 * Re-attach an orphaned thread store to a chosen folder by creating a project
 * entry that reuses the orphan's store id, so the existing thread directories
 * become visible again (issue #997). Returns false if cancelled or already
 * attached.
 */
export async function recoverOrphanProject(
  store: AppStore,
  api: ApiClient,
  storeId: string,
): Promise<boolean> {
  if (store.getState().projects.some((p) => p.id === storeId)) return false
  const path = await api.workspace.open()
  if (!path) return false
  if (store.getState().projects.some((p) => p.id === storeId)) return false
  store.setState({
    projects: [...store.getState().projects, { id: storeId, path, name: basename(path) }],
  })
  store.emit('projects_changed')
  await activateAndWait(store, api, storeId, path)
  return true
}

/** Test hook — reset module-level switch state. */
export function resetProjectSwitchStateForTest(): void {
  switchGeneration = 0
  pendingThreadAfterSwitch = null
  threadCache.clear()
  liveCacheProjectId = null
  projectViewState.clear()
  activationWaiters.clear()
}

/** Test hook — seed sidebar thread cache for a project. */
export function setThreadCacheForTest(projectId: string, threads: Thread[]): void {
  threadCache.set(projectId, threads)
}
