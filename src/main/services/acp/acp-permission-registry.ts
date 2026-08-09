/**
 * ACP `session/request_permission` toolCallIds currently blocked in the approval
 * dialog. When the agent later marks that tool call completed/failed/cancelled
 * without waiting for our answer, we abort the matching waiter so the modal
 * dismisses at the tool boundary — not only at turn end.
 *
 * A leaf of its own rather than state inside `approval.ts`: `acp-client.ts` needs
 * only `cancelApprovalsForAcpToolCall`, and importing it from `approval.ts` pulls
 * that module's whole graph (thread-models → guarded-yolo → project-sandbox →
 * `node-pty`). `acp-client.ts` must stay bundleable as a standalone script for
 * the out-of-process probe worker, and a native module in the graph breaks that
 * at require time. `approval.ts` re-exports these, so its API is unchanged.
 */
const acpPermissionByToolCallId = new Map<string, AbortController>()

/**
 * Register that an ACP permission prompt is open for `toolCallId`. Returns a
 * signal aborted when {@link cancelApprovalsForAcpToolCall} runs, and an
 * unregister function for the normal settle path.
 */
export function trackAcpPermissionToolCall(toolCallId: string): {
  signal: AbortSignal
  unregister: () => void
} {
  // Replace any stale registration for the same id (agent retried the call).
  acpPermissionByToolCallId.get(toolCallId)?.abort()
  const controller = new AbortController()
  acpPermissionByToolCallId.set(toolCallId, controller)
  return {
    signal: controller.signal,
    unregister: (): void => {
      if (acpPermissionByToolCallId.get(toolCallId) === controller) {
        acpPermissionByToolCallId.delete(toolCallId)
      }
    },
  }
}

/**
 * Dismiss the approval tied to an ACP tool call that reached a terminal status
 * (or was abandoned) before the user answered.
 */
export function cancelApprovalsForAcpToolCall(toolCallId: string): boolean {
  const controller = acpPermissionByToolCallId.get(toolCallId)
  if (!controller) return false
  acpPermissionByToolCallId.delete(toolCallId)
  controller.abort()
  return true
}

/** Abort every tracked ACP permission waiter (window close / global settle). */
export function abortAllAcpPermissions(): void {
  for (const controller of acpPermissionByToolCallId.values()) controller.abort()
  acpPermissionByToolCallId.clear()
}
