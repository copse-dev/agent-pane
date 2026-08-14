import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Root for every byte of Copse profile data.
 *
 * One root is the whole point: `~/.copse` (or `COPSE_DIR`) is a complete,
 * relocatable profile, so backing it up or moving it to another machine needs a
 * single directory rather than a checklist. Nothing Copse persists may resolve
 * outside it — see `docs/recovery.md` for the layout that guarantee produces.
 */
export function copseDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_DIR']) ?? join(homedir(), '.copse')
}

/**
 * Electron profile data (`config.json`, `settings.json`, `mcp.json`, `tools/`,
 * the browser profiles and the semantic index).
 *
 * Electron would otherwise default this to `<appData>/copse-panel` —
 * `~/Library/Application Support/copse-panel` on macOS — which put half the
 * profile outside {@link copseDataRoot}. `app-init.ts` overrides Electron's path
 * with this one and migrates any legacy directory across on first launch.
 *
 * `COPSE_PANEL_USER_DATA` still wins, and still means "use exactly this
 * directory": the e2e and eval harnesses point it at a throwaway profile per
 * run, and migration is skipped for it.
 */
export function copseUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_PANEL_USER_DATA']) ?? join(copseDataRoot(env), 'user-data')
}

/**
 * Filesystem-native thread and task store (the chat store).
 *
 * Every consumer that must agree on where the store lives — the thread store,
 * the read-path guard in `workspace.ts`, the seatbelt overlay, and the shell
 * scope classifier — resolves it here so they cannot drift. A classifier that
 * disagreed with the overlay downgraded an in-sandbox read into a "run outside
 * sandbox?" prompt, which is exactly the class of bug a single resolver
 * prevents.
 */
export function copseWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env['COPSE_WORKSPACE_DIR']) ?? join(copseDataRoot(env), 'workspace')
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
