import type { SessionBackup } from '@shared/types/git.ts'
import {
  createWorktreeBackup,
  getGitStatus,
  pruneWorktreeBackups,
  restoreWorktreeBackup,
} from './github/git-service.ts'
import {
  requireThreadExecutionOwner,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'
import { getAgentExecutionRoot } from './execution-root.ts'

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
    state = { root: null, current: null, inFlight: null }
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
export async function ensureSessionBackup(
  root: string | null = getAgentExecutionRoot(),
): Promise<SessionBackup | null> {
  const state = stateFor()
  if (root) state.root = root
  if (state.current) return state.current
  if (state.inFlight) return state.inFlight
  state.inFlight = (async (): Promise<SessionBackup | null> => {
    const status = await getGitStatus(root)
    if (!status) return null
    const paths = [...new Set([...status.staged, ...status.unstaged].map((c) => c.path))]
    if (paths.length === 0) return null
    const ref = await createWorktreeBackup(
      `pre-turn snapshot (${String(paths.length)} path(s))`,
      root,
    )
    if (!ref) return null
    // Prune older snapshots now that a fresh one exists so refs don't accumulate
    // unboundedly; failure to prune must never sink the backup itself.
    await pruneWorktreeBackups(BACKUP_RETENTION, root).catch(() => {})
    state.current = { ref, createdAt: Date.now(), paths }
    return state.current
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
export async function ensureWorktreeRecoverable(
  root: string | null = getAgentExecutionRoot(),
): Promise<boolean> {
  const state = stateFor()
  if (root) state.root = root
  if (state.current) return true
  const status = await getGitStatus(root)
  if (!status) return false
  const dirty = status.staged.length > 0 || status.unstaged.length > 0
  if (!dirty) return true
  return (await ensureSessionBackup(root)) !== null
}

/** The backup taken this turn, if any. */
export function getSessionBackup(owner?: ThreadExecutionOwner): SessionBackup | null {
  return stateFor(owner).current
}

/**
 * Revert the paths captured in the current session backup to their pre-session
 * content — the one-click "Restore pre-session changes" action. Before reverting
 * it snapshots the current (post-agent) worktree so the restore is itself
 * undoable via git, then restores the at-risk paths. Returns false when there is
 * no backup to restore from or the restore could not complete.
 */
export async function restoreSessionBackup(owner?: ThreadExecutionOwner): Promise<boolean> {
  const state = stateFor(owner)
  const backup = state.current
  if (!backup) return false
  // A pre-restore snapshot makes this destructive step reversible: the agent's
  // version of the reverted paths stays recoverable from git even after restore.
  await createWorktreeBackup('pre-restore snapshot', state.root).catch(() => null)
  return restoreWorktreeBackup(backup.ref, backup.paths, state.root)
}

/**
 * Drop the current restore point so the next {@link ensureSessionBackup} takes a
 * fresh snapshot. Called at each turn boundary: the pre-turn worktree is the
 * thing worth protecting, and re-snapshotting per turn keeps the restore point
 * aligned with any manual edits the user made between turns.
 */
export function resetSessionBackup(owner?: ThreadExecutionOwner): void {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  // Replace the whole turn state so a backup already in flight for the prior
  // turn can finish for its caller without publishing into the new turn.
  replaceState(resolvedOwner, { root: getAgentExecutionRoot(), current: null, inFlight: null })
}

/** @internal test helper */
export function setSessionBackupForTest(
  backup: SessionBackup | null,
  owner?: ThreadExecutionOwner,
): void {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  replaceState(resolvedOwner, { root: getAgentExecutionRoot(), current: backup, inFlight: null })
}

/** @internal test helper */
export function clearSessionBackupsForTest(): void {
  statesByProject.clear()
}
