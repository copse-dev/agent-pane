import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The bridged ACP tool-call id a tool execution is serving, when known.
 *
 * The ACP native bridge runs each MCP call in its own async chain, so the id
 * travels by AsyncLocalStorage rather than through every signature between the
 * bridge and the approval gate. `requestApproval` copies it onto the in-flight
 * waiter, which is what lets turn bookkeeping leave a parked call's tool card
 * open while its prompt outlives the turn (see approval.ts).
 *
 * A leaf module of its own — not part of approval.ts — for the same reason
 * acp-permission-registry.ts is one: approval.ts pulls thread-models →
 * guarded-yolo → project-sandbox → node-pty, and importers that must stay
 * bundleable for the out-of-process probe worker cannot load that graph.
 */
const toolCallIdStorage = new AsyncLocalStorage<string | undefined>()

export function runWithApprovalToolCallId<T>(toolCallId: string, fn: () => T): T {
  return toolCallIdStorage.run(toolCallId, fn)
}

export function getApprovalToolCallId(): string | undefined {
  return toolCallIdStorage.getStore()
}

const bridgeExecutionIdStorage = new AsyncLocalStorage<{ id: string; operationKey?: string }>()

/** A bridge execution has its own identity, not a guessed ACP transcript ID. */
export function runWithBridgeExecutionId<T>(
  id: string,
  fn: () => T,
  operation?: { toolName: string; arguments: unknown },
): T {
  return bridgeExecutionIdStorage.run(
    {
      id,
      ...(operation
        ? { operationKey: JSON.stringify([operation.toolName, operation.arguments]) }
        : {}),
    },
    () => toolCallIdStorage.run(undefined, fn),
  )
}

export function getBridgeExecutionId(): string | undefined {
  return bridgeExecutionIdStorage.getStore()?.id
}

/** Private in-memory approval identity; never rendered or written to the audit log. */
export function getApprovalOperationKey(): string | undefined {
  return bridgeExecutionIdStorage.getStore()?.operationKey
}
