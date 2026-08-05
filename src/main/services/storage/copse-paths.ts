import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/** Root for Copse-owned profile data; defaults preserve the existing ~/.copse layout. */
export function copseDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_DIR']) ?? join(homedir(), '.copse')
}

/** Electron profile data. The legacy explicit override remains highest precedence. */
export function copseUserDataDir(defaultDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    nonEmpty(env['COPSE_PANEL_USER_DATA']) ??
    (nonEmpty(env['COPSE_DIR']) ? join(copseDataRoot(env), 'user-data') : defaultDir)
  )
}

/** Filesystem-native thread and task store. */
export function copseWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_WORKSPACE_DIR']) ?? join(copseDataRoot(env), 'workspace')
}

/**
 * Chat-store root as the thread store and the workspace path guards resolve it:
 * `COPSE_WORKSPACE_DIR`, else the literal `~/.copse/workspace`.
 *
 * Deliberately NOT {@link copseWorkspaceDir}: that one also honours `COPSE_DIR`,
 * and the chat store has never moved with it (the unification is the follow-up
 * noted in `workspace.ts`). Every consumer that must agree on where the chat
 * store lives — the thread store, the read-path guard, the seatbelt overlay, and
 * the shell scope classifier — resolves it here so they cannot drift. A
 * classifier that disagreed with the overlay is exactly the bug this fixes.
 */
export function chatStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_WORKSPACE_DIR']) ?? join(homedir(), '.copse', 'workspace')
}

/** Root for Copse-managed Git worktrees. */
export function copseWorktreesDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_WORKTREES_DIR']) ?? join(copseDataRoot(env), 'worktrees')
}

/**
 * Per-project directory under the workspace store (`<workspace>/<projectId>`).
 *
 * The durable decision log (#656) writes per-project files, so the project id
 * is rejected if it escapes the store root.
 */
export function projectStoreDir(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = resolve(copseWorkspaceDir(env))
  const candidate = resolve(root, projectId)
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Project id resolves outside the workspace store')
  }
  return candidate
}
