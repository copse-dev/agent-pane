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

/**
 * How long a status read stands without a working-tree event for its root.
 * Watched roots (the open thread, running agents) refresh on events; this only
 * bounds how stale an unwatched checkout edited outside Copse can look.
 */
const WORK_TTL_MS = 5 * 60_000
/** How long another project's thread list stands before it is re-read from disk. */
const METADATA_TTL_MS = 60_000
/** Concurrent inspect-only Git reads. */
const MAX_IN_FLIGHT = 2
/** Threads tried for one shared checkout before it is reported unavailable. */
const MAX_SHARED_ATTEMPTS = 3

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

interface WorkTarget {
  key: string
  /** The checkout the read resolves to, matched against working-tree events. */
  root: string
}

/**
 * Threads without a worktree share their project's checkout, so they share one
 * status read. An isolated worktree is its own target; its recorded path is
 * diagnostic, but it is what main reports in working-tree events.
 */
function workTarget(entry: ThreadBrowserEntry): WorkTarget {
  const { project, thread } = entry
  const worktree = thread.worktree
  if (!worktree) return { key: `shared/${project.id}/${project.path}`, root: project.path }
  return {
    key: `worktree/${threadEntryKey(entry)}/${String(worktree.createdAt)}/${String(worktree.retiredAt ?? '')}`,
    root: worktree.path,
  }
}

function sameRoot(left: string, right: string): boolean {
  const trim = (path: string): string => (path.length > 1 ? path.replace(/[/\\]+$/, '') : path)
  return trim(left) === trim(right)
}

interface ThreadBrowserData {
  entries: () => ThreadBrowserEntry[]
  load: () => void
  inspect: (targets: readonly ThreadBrowserEntry[], force?: boolean) => void
  /** Re-read only the checkouts a working-tree event names. */
  invalidateRoot: (root: string) => void
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
  now: () => number = Date.now,
): ThreadBrowserData {
  const saved = new Map<string, { threads: SidebarThread[]; loadedAt: number }>()
  const loading = new Set<string>()
  const failures = new Set<string>()
  const work = new Map<string, { value: ThreadWorkSummary | null; checkedAt: number }>()
  const known = new Map<string, { root: string; entries: ThreadBrowserEntry[] }>()
  const queued = new Map<string, ThreadBrowserEntry[]>()
  const inFlight = new Set<string>()
  let disposed = false
  const isDisposed = (): boolean => disposed

  // Legacy rows' PR links arrive after a visible-row backfill; another
  // project's rows read them from this list rather than the active store.
  const offPrRefs = api.threads.onPrRefs((projectId, refs) => {
    const list = saved.get(projectId)
    if (!list || refs.length === 0) return
    const byThread = new Map(refs.map((entry) => [entry.threadId, entry.prRefs]))
    if (!list.threads.some((thread) => byThread.has(thread.id))) return
    list.threads = list.threads.map((thread) => {
      const prRefs = byThread.get(thread.id)
      return prRefs ? { ...thread, prRefs } : thread
    })
    changed()
  })

  function entries(): ThreadBrowserEntry[] {
    const state = store.getState()
    return state.projects.flatMap((project) => {
      const listed =
        project.id === state.activeProjectId
          ? getSidebarThreads(store, project.id)
          : (saved.get(project.id)?.threads ?? getSidebarThreads(store, project.id))
      const threads = new Map(listed.map((thread) => [thread.id, thread]))
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
        saved.set(projectId, { threads, loadedAt: now() })
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
      if (project.id === state.activeProjectId) {
        // The live store owns this project now; re-read it from disk once the
        // user leaves rather than showing a list frozen before they arrived.
        saved.delete(project.id)
        continue
      }
      const list = saved.get(project.id)
      if (failures.has(project.id) || project.missing) continue
      if (!list || now() - list.loadedAt >= METADATA_TTL_MS) void loadProject(project.id)
    }
    for (const projectId of saved.keys()) {
      if (!state.projects.some((project) => project.id === projectId)) saved.delete(projectId)
    }
  }

  async function readWork(key: string, candidates: readonly ThreadBrowserEntry[]): Promise<void> {
    let value: ThreadWorkSummary | null = null
    try {
      for (const entry of candidates.slice(0, MAX_SHARED_ATTEMPTS)) {
        if (disposed) return
        try {
          const status = await api.git.status(entry.project.id, entry.thread.id, true)
          value = status ? summarizeThreadWork(status) : null
          break
        } catch {
          // A thread that is not saved yet cannot resolve its checkout; another
          // thread sharing the same checkout can.
        }
      }
      if (!disposed) work.set(key, { value, checkedAt: now() })
    } finally {
      inFlight.delete(key)
      if (!disposed) {
        pump()
        changed()
      }
    }
  }

  function pump(): void {
    for (const [key, candidates] of queued) {
      if (disposed || inFlight.size >= MAX_IN_FLIGHT) break
      if (inFlight.has(key)) continue
      queued.delete(key)
      inFlight.add(key)
      void readWork(key, candidates)
    }
  }

  function inspect(targets: readonly ThreadBrowserEntry[], force = false): void {
    const grouped = new Map<string, { root: string; entries: ThreadBrowserEntry[] }>()
    for (const entry of targets) {
      const target = workTarget(entry)
      if (entry.project.sshHost || entry.thread.worktree?.retiredAt != null) {
        work.set(target.key, { value: null, checkedAt: now() })
        continue
      }
      const group = grouped.get(target.key)
      if (group) group.entries.push(entry)
      else grouped.set(target.key, { root: target.root, entries: [entry] })
    }
    for (const [key, group] of grouped) {
      known.set(key, group)
      if (inFlight.has(key)) {
        if (force) queued.set(key, group.entries)
        continue
      }
      const cached = work.get(key)
      if (!force && cached && now() - cached.checkedAt < WORK_TTL_MS) continue
      queued.set(key, group.entries)
    }
    pump()
  }

  function invalidateRoot(root: string): void {
    const matches = [...known.values()].filter((group) => sameRoot(group.root, root))
    if (matches.length > 0)
      inspect(
        matches.flatMap((group) => group.entries),
        true,
      )
  }

  return {
    entries,
    load,
    inspect,
    invalidateRoot,
    summary: (entry: ThreadBrowserEntry): ThreadWorkSummary | null | undefined =>
      work.get(workTarget(entry).key)?.value,
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
      offPrRefs()
    },
  }
}
