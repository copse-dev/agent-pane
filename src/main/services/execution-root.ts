import { getThreadExecutionContext } from './thread-execution-context.ts'
import { getExplicitWorkspaceRoot } from './workspace.ts'

/**
 * Filesystem root for work performed on behalf of the running agent turn.
 *
 * It is the turn's trusted AsyncLocal execution context, else the root of a
 * headless run scoped with `runWithWorkspaceRoot`, else null. It never falls
 * back to the process-global workspace: that is whichever window switched
 * project last, so a caller outside a turn would act on another window's
 * project (#3958). A caller outside a turn (an IPC handler, a timer) names its
 * root explicitly: from its window (`senderProjectRoot`), its thread
 * (`resolveThreadExecutionContext`) or stored state.
 */
export function getAgentExecutionRoot(): string | null {
  return getThreadExecutionContext()?.root ?? getExplicitWorkspaceRoot()
}

/**
 * Persisted project root used for project-level trust and configuration lookup.
 * In worktree mode this deliberately differs from {@link getAgentExecutionRoot}:
 * repo-supplied config remains anchored to the trusted project, while file and
 * command effects land in the thread checkout. Resolved the same way, with no
 * process-global fallback.
 */
export function getAgentProjectRoot(): string | null {
  return getThreadExecutionContext()?.projectRoot ?? getExplicitWorkspaceRoot()
}

/**
 * The two roots a permission decision is judged against: the persisted project
 * (trust and repo-supplied config) and the checkout commands run in. Security
 * readers take these explicitly so two runs in different projects or worktrees
 * cannot read each other's roots (#3958).
 */
export interface AgentRoots {
  readonly projectRoot: string | null
  readonly executionRoot: string | null
}

/** The current agent run's {@link AgentRoots}, resolved the same way as the getters above. */
export function currentAgentRoots(): AgentRoots {
  return { projectRoot: getAgentProjectRoot(), executionRoot: getAgentExecutionRoot() }
}

export function requireAgentExecutionRoot(): string {
  const root = getAgentExecutionRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')
  return root
}

/**
 * The workspace path stated to a subagent in its brief. Must be the execution
 * root, not the renderer workspace root: a subagent's tools resolve against the
 * turn's root, so in worktree mode naming the shared checkout would point the
 * model at a tree its tools never touch (#1724).
 */
export function agentWorkspaceLabel(): string {
  return getAgentExecutionRoot() ?? '(none)'
}
