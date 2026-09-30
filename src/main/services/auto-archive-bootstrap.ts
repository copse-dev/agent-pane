import { getSetting } from './storage/settings.ts'
import { storageGet } from './storage/storage.ts'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { loadProjectThreadMetas, updateMeta } from './thread-store.ts'
import { listRunningThreadIds } from './agent-service.ts'
import { countStagedDiffs } from './diff-queue.ts'
import { getGhPrDetails } from './github/gh-pr-service.ts'
import { runWorktreeGit } from './worktree-manager.ts'
import {
  inspectThreadWorktree,
  runAutoArchiveSweep,
  snapshotFromDetails,
  type AutoArchiveDeps,
  type AutoArchiveProject,
} from './auto-archive-service.ts'

/** Wait for startup to settle (indexing, sandbox, renderer boot) before the first pass. */
const FIRST_SWEEP_DELAY_MS = 60_000
/** Then catch threads that cross the threshold while the app stays open. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

function configuredProjects(): AutoArchiveProject[] {
  const stored = storageGet('projects')
  if (!Array.isArray(stored)) return []
  const projects: AutoArchiveProject[] = []
  for (const entry of stored) {
    if (!isRecord(entry)) continue
    const { id, path, sshHost } = entry
    if (typeof id !== 'string' || typeof path !== 'string') continue
    projects.push({ id, path, ...(typeof sshHost === 'string' ? { sshHost } : {}) })
  }
  return projects
}

function liveDeps(): AutoArchiveDeps {
  return {
    afterDays: () => getSetting('autoArchiveAfterDays', 0),
    projects: configuredProjects,
    loadThreads: (projectId) => loadProjectThreadMetas(projectId, { includeArchived: false }),
    runningThreadIds: () => new Set(listRunningThreadIds()),
    stagedDiffCount: (projectId, threadId) => countStagedDiffs({ projectId, threadId }),
    prSnapshot: async (ref) => snapshotFromDetails(await getGhPrDetails(ref)),
    worktreeFacts: (_project, thread) =>
      inspectThreadWorktree(thread, (cwd, args) => runWorktreeGit(cwd, args)),
    archive: (projectId, threadId, now) =>
      updateMeta(projectId, threadId, { archivedAt: now, updatedAt: now }),
    now: Date.now,
  }
}

async function sweepOnce(): Promise<void> {
  try {
    const { archived } = await runAutoArchiveSweep(liveDeps())
    for (const { projectId, threadIds } of archived) {
      console.log(
        `[auto-archive] archived ${String(threadIds.length)} merged thread(s) in ${projectId}`,
      )
      broadcastToAppWindows('threads:auto-archived', projectId, threadIds)
    }
  } catch (err) {
    console.warn('[auto-archive] sweep failed:', err)
  }
}

/** Start the periodic sweep. The timers are unref'd so they never hold the app open. */
export function startAutoArchive(): () => void {
  const first = setTimeout(() => {
    void sweepOnce()
  }, FIRST_SWEEP_DELAY_MS)
  const every = setInterval(() => {
    void sweepOnce()
  }, SWEEP_INTERVAL_MS)
  first.unref()
  every.unref()
  return (): void => {
    clearTimeout(first)
    clearInterval(every)
  }
}
