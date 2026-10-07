import type { McpToolAnnotations } from '@shared/types/mcp.ts'
import {
  isMcpToolAllowedInReadonlyMode,
  READONLY_AGENT_TOOLS,
  REQUEST_WRITE_ACCESS_TOOL,
} from './readonly-tools.ts'

/**
 * Tools that never touch the execution root, beyond the read-only allow-list:
 * network reads, CI/PR inspection, and remote PR actions that need no local
 * branch. A deferred-worktree thread runs these against the project checkout
 * without allocating. `gh_pr_create` is deliberately absent: it needs the
 * thread's own branch.
 */
export const CHECKOUT_NEUTRAL_TOOLS = new Set<string>([
  'web_search',
  'fetch_url',
  'parallel_search',
  'gh_pr_view',
  'gh_pr_list',
  'gh_pr_files',
  'gh_run_list',
  'gh_run_view',
  'get_ci_status',
  'get_ci_failure_logs',
  'wait_for_ci_checks',
  'gh_pr_approve',
  'gh_pr_enable_auto_merge',
  'gh_pr_mark_ready',
  'gh_pr_rerun_failed_ci',
  'update_todos',
  'suggest_model',
  'advisor',
])

export interface DeferredCheckoutToolCall {
  toolName: string
  mcpAnnotations?: McpToolAnnotations | undefined
  /** Routing facts for `run_shell`; absent means they could not be read. */
  shell?: {
    sandboxEnabled: boolean
    runsOutsideSandbox: boolean
    expectsSandboxBlock: boolean
  }
}

/**
 * Whether a deferred-worktree thread must allocate its worktree before this
 * call runs. Default-allocate: a tool not known to leave the checkout alone
 * gets a worktree first, which is exactly what every thread got before
 * deferral existed, so an unlisted tool costs an allocation, never safety.
 *
 * `run_shell` stays deferred only while it will run contained: the read-only
 * checkout profile has no unsandboxed path, so a command routed outside the
 * sandbox (or with no sandbox at all) needs the worktree it would write into.
 */
export function toolNeedsWritableCheckout(call: DeferredCheckoutToolCall): boolean {
  const { toolName } = call
  if (toolName === REQUEST_WRITE_ACCESS_TOOL) return false
  if (toolName === 'run_shell') {
    const shell = call.shell
    if (!shell) return true
    return !shell.sandboxEnabled || shell.runsOutsideSandbox || shell.expectsSandboxBlock
  }
  if (toolName.startsWith('mcp__')) return !isMcpToolAllowedInReadonlyMode(call.mcpAnnotations)
  return !READONLY_AGENT_TOOLS.has(toolName) && !CHECKOUT_NEUTRAL_TOOLS.has(toolName)
}
