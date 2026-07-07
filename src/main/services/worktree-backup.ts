import { createWorktreeBackup, getGitStatus } from './github/git-service.ts'

/**
 * A restore point for the user's pre-agent worktree. `ref` names a
 * `refs/copse/backups/*` commit capturing every uncommitted change (tracked and
 * untracked) as it was before Copse began applying edits over it.
 */
export interface SessionBackup {
  ref: string
  createdAt: number
  /** Workspace-relative paths that were dirty when the backup was taken. */
  paths: string[]
}

let current: SessionBackup | null = null
let inFlight: Promise<SessionBackup | null> | null = null

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
export async function ensureSessionBackup(): Promise<SessionBackup | null> {
  if (current) return current
  if (inFlight) return inFlight
  inFlight = (async (): Promise<SessionBackup | null> => {
    const status = await getGitStatus()
    if (!status) return null
    const paths = [...new Set([...status.staged, ...status.unstaged].map((c) => c.path))]
    if (paths.length === 0) return null
    const ref = await createWorktreeBackup(`pre-turn snapshot (${String(paths.length)} path(s))`)
    if (!ref) return null
    current = { ref, createdAt: Date.now(), paths }
    return current
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
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
export async function ensureWorktreeRecoverable(): Promise<boolean> {
  if (current) return true
  const status = await getGitStatus()
  if (!status) return false
  const dirty = status.staged.length > 0 || status.unstaged.length > 0
  if (!dirty) return true
  return (await ensureSessionBackup()) !== null
}

/** The backup taken this turn, if any. */
export function getSessionBackup(): SessionBackup | null {
  return current
}

/**
 * Drop the current restore point so the next {@link ensureSessionBackup} takes a
 * fresh snapshot. Called at each turn boundary: the pre-turn worktree is the
 * thing worth protecting, and re-snapshotting per turn keeps the restore point
 * aligned with any manual edits the user made between turns.
 */
export function resetSessionBackup(): void {
  current = null
}

/** @internal test helper */
export function setSessionBackupForTest(backup: SessionBackup | null): void {
  current = backup
  inFlight = null
}
