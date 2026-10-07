import { parseAcpModel } from '@shared/acp.ts'
import { getSetting } from '../storage/settings.ts'
import { getAcpAgent, resolveAcpSandbox } from './acp-agent-registry.ts'
import { willSandboxAcpAgent } from './acp-client.ts'

/**
 * Whether an ACP agent can start a thread on a read-only view of the user's
 * checkout and take its worktree later (docs/plans/deferred-thread-worktrees.md).
 *
 * Deferral is only safe when Copse can contain the agent's own writes, because
 * it cannot intercept them the way it intercepts a native tool call:
 *
 * - the agent spawns under the project sandbox, so the checkout can be made
 *   read-only for its process (the macOS seatbelt, or the Linux equivalent);
 * - it runs on this machine, where that sandbox applies;
 * - the native bridge is on, so `request_write_access` can reach it.
 *
 * Anything else keeps the eager worktree. "When in doubt, allocate."
 */
export function acpAgentCanDeferCheckout(agentId: string, options: { remote: boolean }): boolean {
  if (options.remote) return false
  if (!getSetting<boolean>('acpNativeBridgeEnabled', true)) return false
  const agent = getAcpAgent(agentId)
  return agent !== null && willSandboxAcpAgent(resolveAcpSandbox(agent))
}

/** {@link acpAgentCanDeferCheckout} for a model picker value such as `acp:claude-code`. */
export function acpModelCanDeferCheckout(model: string, options: { remote: boolean }): boolean {
  const agentId = parseAcpModel(model)
  return agentId !== null && acpAgentCanDeferCheckout(agentId, options)
}
