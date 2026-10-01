import type { AppStore } from '@shared/store/store.ts'
import type { Project, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { SidebarThread } from './sidebar-thread.ts'
import { getSidebarThreads } from './projects.ts'

export interface ThreadBrowserEntry {
  project: Project
  thread: SidebarThread
}

export interface ThreadWorkSummary {
  count: number
  staged: number
  unstaged: number
  untracked: number
}

export function summarizeThreadWork(status: GitStatusResult): ThreadWorkSummary {
  return {
    count: new Set([...status.staged, ...status.unstaged].map((change) => change.path)).size,
    staged: status.staged.length,
    unstaged: status.unstaged.filter((change) => change.status !== 'untracked').length,
    untracked: status.unstaged.filter((change) => change.status === 'untracked').length,
  }
}

export function threadEntryKey(entry: ThreadBrowserEntry): string {
  return `${entry.project.id}/${entry.thread.id}`
}

function workKey(entry: ThreadBrowserEntry): string {
  return `${threadEntryKey(entry)}/${entry.project.path}/${String(entry.thread.worktree?.createdAt ?? 'shared')}/${String(entry.thread.worktree?.retiredAt ?? '')}`
}

function threadMetadata(thread: SidebarThread): SidebarThread {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.unreadAt !== undefined ? { unreadAt: thread.unreadAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.gitBranch !== undefined ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.worktree !== undefined ? { worktree: thread.worktree } : {}),
    ...(thread.automation !== undefined ? { automation: thread.automation } : {}),
  }
}

interface ThreadBrowserData {
  entries: () => ThreadBrowserEntry[]
  load: () => void
  inspect: (targets: readonly ThreadBrowserEntry[], force?: boolean) => void
  summary: (entry: ThreadBrowserEntry) => ThreadWorkSummary | null | undefined
  pending: () => boolean
  failed: () => boolean
  refresh: () => void
  dispose: () => void
}

export function createThreadBrowserData(
  store: AppStore,
  api: ApiClient,
  changed: () => void,
): ThreadBrowserData {
  const saved = new Map<string, SidebarThread[]>()
  const loading = new Set<string>()
  const failures = new Set<string>()
  const work = new Map<string, { value: ThreadWorkSummary | null; checkedAt: number }>()
  const queued = new Map<string, ThreadBrowserEntry>()
  const inFlight = new Set<string>()
  let disposed = false
  const isDisposed = (): boolean => disposed

  function entries(): ThreadBrowserEntry[] {
    const state = store.getState()
    if (state.activeProjectId) saved.set(state.activeProjectId, state.threads.map(threadMetadata))
    return state.projects.flatMap((project) => {
      const live = getSidebarThreads(store, project.id)
      const threads = new Map(
        (project.id === state.activeProjectId ? live : (saved.get(project.id) ?? live)).map(
          (thread) => [thread.id, thread],
        ),
      )
      for (const carried of state.backgroundThreads) {
        if (carried.projectId === project.id) threads.set(carried.thread.id, carried.thread)
      }
      return [...threads.values()]
        .filter((thread) => thread.archivedAt == null)
        .map((thread) => ({ project, thread }))
    })
  }

  async function loadProject(projectId: string): Promise<void> {
    if (disposed || loading.has(projectId)) return
    loading.add(projectId)
    failures.delete(projectId)
    try {
      const threads: Thread[] = await api.threads.loadProject(projectId)
      if (
        !isDisposed() &&
        store.getState().activeProjectId !== projectId &&
        store.getState().projects.some((project) => project.id === projectId)
      ) {
        saved.set(projectId, threads.map(threadMetadata))
      }
    } catch {
      if (!isDisposed()) failures.add(projectId)
    } finally {
      loading.delete(projectId)
      if (!isDisposed()) changed()
    }
  }

  function load(): void {
    const state = store.getState()
    for (const project of state.projects) {
      if (
        project.id !== state.activeProjectId &&
        !saved.has(project.id) &&
        !failures.has(project.id)
      ) {
        void loadProject(project.id)
      }
    }
    for (const projectId of saved.keys()) {
      if (!state.projects.some((project) => project.id === projectId)) saved.delete(projectId)
    }
  }

  async function readWork(entry: ThreadBrowserEntry, key: string): Promise<void> {
    try {
      const status = await api.git.status(entry.project.id, entry.thread.id, true)
      if (!disposed)
        work.set(key, { value: status ? summarizeThreadWork(status) : null, checkedAt: Date.now() })
    } catch {
      if (!disposed) work.set(key, { value: null, checkedAt: Date.now() })
    } finally {
      inFlight.delete(key)
      if (!disposed) {
        pump()
        changed()
      }
    }
  }

  function pump(): void {
    for (const [key, entry] of queued) {
      if (disposed || inFlight.size >= 2) break
      if (inFlight.has(key)) continue
      queued.delete(key)
      inFlight.add(key)
      void readWork(entry, key)
    }
  }

  function inspect(targets: readonly ThreadBrowserEntry[], force = false): void {
    for (const entry of targets) {
      const key = workKey(entry)
      if (entry.project.sshHost || entry.thread.worktree?.retiredAt != null) {
        work.set(key, { value: null, checkedAt: Date.now() })
        continue
      }
      const cached = work.get(key)
      if (inFlight.has(key)) {
        if (force) queued.set(key, entry)
        continue
      }
      if (!force && cached && Date.now() - cached.checkedAt < 30_000) continue
      queued.set(key, entry)
    }
    pump()
  }

  return {
    entries,
    load,
    inspect,
    summary: (entry: ThreadBrowserEntry): ThreadWorkSummary | null | undefined =>
      work.get(workKey(entry))?.value,
    pending: (): boolean => loading.size > 0 || queued.size > 0 || inFlight.size > 0,
    failed: (): boolean => failures.size > 0,
    refresh: (): void => {
      failures.clear()
      for (const project of store.getState().projects) {
        if (project.id !== store.getState().activeProjectId) void loadProject(project.id)
      }
      inspect(entries(), true)
    },
    dispose: (): void => {
      disposed = true
      queued.clear()
    },
  }
}
