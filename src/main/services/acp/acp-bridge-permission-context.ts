import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Permission context for Copse's ACP native-tool bridge.
 *
 * A sandboxed ACP agent widens ASRT's process-global network allowlist for its
 * whole lifetime (#803 / `network-scope.ts`). Bridged `run_shell` calls re-enter
 * the host permission gate; without this flag they look like "another process"
 * overlapping that scope and force a prompt even for sandbox-contained commands
 * (`git status`, …). The bridge is the agent's own tool surface, so when the
 * session is sandboxed the gate should treat those calls as already covered by
 * the active scope — the same as direct `session/request_permission` execute
 * handling (`networkScopeAlreadyApplies: agent.sandboxed`).
 */
export interface AcpBridgePermissionContext {
  networkScopeAlreadyApplies: boolean
}

const store = new AsyncLocalStorage<AcpBridgePermissionContext>()

export function runWithAcpBridgePermissionContext<T>(
  context: AcpBridgePermissionContext,
  run: () => T,
): T {
  return store.run(context, run)
}

/** True when the current async chain is a sandboxed ACP bridge tool call. */
export function acpBridgeNetworkScopeAlreadyApplies(): boolean {
  return store.getStore()?.networkScopeAlreadyApplies === true
}
