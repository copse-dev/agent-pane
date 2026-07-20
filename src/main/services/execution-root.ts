import { getThreadExecutionContext } from './thread-execution-context.ts'
import { getWorkspaceRoot } from './workspace.ts'

/**
 * Filesystem root for work performed on behalf of the active agent run.
 *
 * Agent turns prefer their trusted AsyncLocal execution context; main-process
 * callers outside a turn keep the existing renderer-selected workspace behavior.
 * This fallback is intentionally for non-agent IPC and tests only — a worktree
 * context never falls back to the shared checkout when its root is present.
 */
export function getAgentExecutionRoot(): string | null {
  return getThreadExecutionContext()?.root ?? getWorkspaceRoot()
}

/**
 * Persisted project root used for project-level trust and configuration lookup.
 * In worktree mode this deliberately differs from {@link getAgentExecutionRoot}:
 * repo-supplied config remains anchored to the trusted project, while file and
 * command effects land in the thread checkout.
 */
export function getAgentProjectRoot(): string | null {
  return getThreadExecutionContext()?.projectRoot ?? getWorkspaceRoot()
}

export function requireAgentExecutionRoot(): string {
  const root = getAgentExecutionRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')
  return root
}
