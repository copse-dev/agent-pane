import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Single source of truth for the root of Copse's on-disk store (issue #644),
 * honoring the `COPSE_WORKSPACE_DIR` override used by tests and relocation.
 *
 * Historically `thread-store.ts` and `workspace.ts` each duplicated this
 * resolution (both carried a "a follow-up unifies both under one COPSE_DIR"
 * note); the durable decision log (#656) needs the same root, so it is factored
 * out here and shared. Default is `~/.copse/workspace`.
 */
export function workspaceRoot(): string {
  const override = process.env['COPSE_WORKSPACE_DIR']?.trim()
  if (override && override.length > 0) return override
  return join(homedir(), '.copse', 'workspace')
}

/** Per-project directory under the store root (`<root>/<projectId>`). */
export function projectStoreDir(projectId: string): string {
  return join(workspaceRoot(), projectId)
}
