import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** Root for Copse-managed Git worktrees. */
export function copseWorktreesDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_WORKTREES_DIR']) ?? join(copseDataRoot(env), 'worktrees')
}
