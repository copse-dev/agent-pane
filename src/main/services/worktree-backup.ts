import {
  clearSessionBackupBinding,
  loadSessionBackupBinding,
  saveSessionBackupBinding,
} from './thread-store.ts'
import type { SessionBackup } from '@shared/types/git.ts'
import {
  createWorktreeBackup,
  getGitStatus,
  getWorktreeBackupState,
  pruneWorktreeBackups,
  restoreWorktreeBackup,
} from './github/git-service.ts'
import {
  requireThreadExecutionOwner,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'
import { getAgentExecutionRoot } from './execution-root.ts'
import { noteWorktreeWrite } from './worktree-writers.ts'

export type { SessionBackup }

/**
 * How many `refs/copse/backups/*` snapshots to retain. Each dirty turn mints one
 * ref; without a cap they accumulate for the life of the repository. A handful
 * keeps a short trail of recent restore points while bounding the clutter.
 */
const BACKUP_RETENTION = 10

interface SessionBackupState {
  root: string | null
  current: SessionBackup | null
  inFlight: Promise<SessionBackup | null> | null
  refresh: boolean
}

const statesByProject = new Map<string, Map<string, SessionBackupState>>()

function stateFor(owner: ThreadExecutionOwner = requireThreadExecutionOwner()): SessionBackupState {
  let projectStates = statesByProject.get(owner.projectId)
  if (!projectStates) {
    projectStates = new Map()
    statesByProject.set(owner.projectId, projectStates)
  }
  let state = projectStates.get(owner.threadId)
  if (!state) {
    const saved = loadSessionBackupBinding(owner.projectId, owner.threadId)
    state = {
      root: saved?.root ?? null,
      current: saved?.backup ?? null,
      inFlight: null,
      refresh: true,
    }
    projectStates.set(owner.threadId, state)
  }
  return state
}

function replaceState(owner: ThreadExecutionOwner, state: SessionBackupState): void {
  let projectStates = statesByProject.get(owner.projectId)
  if (!projectStates) {
    projectStates = new Map()
    statesByProject.set(owner.projectId, projectStates)
  }
  projectStates.set(owner.threadId, state)
}

/**
 * Ensure a durable restore point exists before Copse auto-applies edits over a
 * dirty worktree, so the user's uncommitted work is always recoverable rather
 * than protected by a per-edit approval prompt.
 *
 * Idempotent within a turn: the first call that finds a dirty worktree takes one
 * backup and every later call reuses it until {@link resetSessionBackup}. Two
 * concurrent callers share a single in-flight snapshot. Returns null when the
 * worktree is clean (nothing to protect) or the backup could not be created — in
 * the latter case the caller must fall back to asking for approval, since it has
 * no safety net.
 */
export async function ensureSessionBackup(root: string | null): Promise<SessionBackup | null> {
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  if (!root) return null
  if (state.root !== root) {
    state.root = root
    state.current = null
    state.refresh = true
  }
  if (!state.refresh) {
    if (!state.current) return null
    const current = await getRestorableSessionBackup(owner, root)
    const latest = stateFor(owner)
    if (latest !== state) return null
    if (current || !latest.refresh) return current
  }
  if (state.inFlight) return state.inFlight
  state.inFlight = (async (): Promise<SessionBackup | null> => {
    const status = await getGitStatus(root, { untrackedFiles: 'all' })
    if (!status) return null
    const paths = [...new Set([...status.staged, ...status.unstaged].map((c) => c.path))]
    if (paths.length === 0) {
      if (stateFor(owner) === state) {
        await clearSessionBackupBinding(owner.projectId, owner.threadId)
        state.current = null
        state.refresh = false
      }
      return null
    }
    const ref = await createWorktreeBackup(
      `pre-turn snapshot (${String(paths.length)} path(s))`,
      root,
    )
    if (!ref) return null
    // Prune older snapshots now that a fresh one exists so refs don't accumulate
    // unboundedly; failure to prune must never sink the backup itself.
    await pruneWorktreeBackups(BACKUP_RETENTION, root).catch(() => {})
    const backup = { ref, createdAt: Date.now(), paths }
    // A read-only turn keeps the previous point. Publish a replacement only
    // after both the Git snapshot and its thread-owned pointer are durable.
    if (stateFor(owner) === state) {
      await saveSessionBackupBinding(owner.projectId, owner.threadId, { v: 1, root, backup })
      state.current = backup
      state.refresh = false
    }
    return backup
  })()
  try {
    return await state.inFlight
  } finally {
    state.inFlight = null
  }
}

/**
 * Whether the worktree is in a state where Copse can safely apply/approve file
 * writes without a per-edit prompt: either it is clean (nothing to lose) or a
 * durable backup of the user's uncommitted work exists (taking one now if
 * needed). Returns false only when the worktree is dirty and could not be backed
 * up, or git is unavailable — cases where a prompt is still the safe default.
 *
 * Distinct from {@link ensureSessionBackup}, whose null return conflates "clean"
 * with "backup failed"; callers gating auto-approval need the two kept apart.
 */
export async function ensureWorktreeRecoverable(root: string | null): Promise<boolean> {
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  if (!root) return false
  if (state.root !== root) {
    state.root = root
    state.current = null
    state.refresh = true
  }
  // A clean result has no durable safety net. ACP permission requests must
  // recheck it: user work may appear while the same external-agent turn runs.
  if (!state.refresh && state.current !== null) {
    if (await getRestorableSessionBackup(owner, root)) return true
    const latest = stateFor(owner)
    if (latest !== state || !latest.refresh) return false
  }
  const status = await getGitStatus(root, { untrackedFiles: 'all' })
  if (!status) return false
  const dirty = status.staged.length > 0 || status.unstaged.length > 0
  if (!dirty) {
    await clearSessionBackupBinding(owner.projectId, owner.threadId)
    state.current = null
    state.refresh = false
    return true
  }
  state.refresh = true
  return (await ensureSessionBackup(root)) !== null
}

/** Cached point for edit bookkeeping; use getRestorableSessionBackup before offering restore. */
export function getSessionBackup(
  owner?: ThreadExecutionOwner,
  root = getAgentExecutionRoot(),
): SessionBackup | null {
  const state = stateFor(owner)
  return root !== null && state.root === root ? state.current : null
}

/** Validate the retained ref and baseline before offering or performing a restore. */
export async function getRestorableSessionBackup(
  owner?: ThreadExecutionOwner,
  root = getAgentExecutionRoot(),
): Promise<SessionBackup | null> {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  const state = stateFor(resolvedOwner)
  const backup = getSessionBackup(resolvedOwner, root)
  if (!backup || !root) return null
  const validity = await getWorktreeBackupState(backup.ref, root).catch(() => 'unavailable')
  if (stateFor(resolvedOwner) !== state || state.current !== backup || state.root !== root)
    return null
  if (validity === 'current') return backup
  if (validity === 'stale') {
    // Retire only a demonstrably expired point. Read/clear failures leave its
    // durable binding available for a later retry, without offering Restore.
    try {
      await clearSessionBackupBinding(resolvedOwner.projectId, resolvedOwner.threadId, {
        v: 1,
        root,
        backup,
      })
    } catch {
      return null
    }
    if (stateFor(resolvedOwner) === state && state.current === backup) {
      state.current = null
      state.refresh = true
    }
  }
  return null
}

/**
 * Revert the paths captured in the current session backup to their pre-session
 * content — the one-click "Restore pre-session changes" action. Before reverting
 * it snapshots the current (post-agent) worktree so the restore is itself
 * undoable via git, then restores the at-risk paths. Returns false when there is
 * no backup to restore from or the restore could not complete.
 */
export async function restoreSessionBackup(
  owner?: ThreadExecutionOwner,
  root = getAgentExecutionRoot(),
): Promise<boolean> {
  const state = stateFor(owner)
  const backup = await getRestorableSessionBackup(owner, root)
  if (!backup) return false
  // A pre-restore snapshot makes this destructive step reversible: the agent's
  // version of the reverted paths stays recoverable from git even after restore.
  const safetyRef = await createWorktreeBackup('pre-restore snapshot', state.root).catch(() => null)
  if (!safetyRef) return false
  // The safety snapshot may take time; recheck the point after it and before
  // touching any files, including when HEAD moved while a dialog was open.
  if ((await getRestorableSessionBackup(owner, root)) !== backup) return false
  try {
    return await restoreWorktreeBackup(backup.ref, backup.paths, state.root)
  } finally {
    // The restore rewrites paths behind the diff queue's ownership records.
    noteWorktreeWrite()
  }
}

/**
 * Keep the current restore point visible while the next {@link ensureSessionBackup} takes a
 * fresh snapshot before any new edit. Called at each turn boundary: the pre-turn worktree is the
 * thing worth protecting, and re-snapshotting per turn keeps the restore point
 * aligned with any manual edits the user made between turns.
 */
export function resetSessionBackup(owner?: ThreadExecutionOwner): void {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  const previous = stateFor(resolvedOwner)
  const root = getAgentExecutionRoot() ?? previous.root
  // Refresh lazily before the next actual write. Questions and proposals must
  // not discard the restore point for edits the user is still reviewing.
  replaceState(resolvedOwner, {
    root,
    current: previous.root === root ? previous.current : null,
    inFlight: null,
    refresh: true,
  })
  // The user had the floor since the last turn, so the diff queue's remembered
  // clean sweep no longer describes the tree this turn's restore point protects.
  noteWorktreeWrite()
}

/** @internal test helper */
export function setSessionBackupForTest(
  backup: SessionBackup | null,
  owner?: ThreadExecutionOwner,
): void {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  replaceState(resolvedOwner, {
    root: getAgentExecutionRoot(),
    current: backup,
    inFlight: null,
    refresh: false,
  })
}

/** @internal test helper */
export function clearSessionBackupsForTest(): void {
  statesByProject.clear()
}
