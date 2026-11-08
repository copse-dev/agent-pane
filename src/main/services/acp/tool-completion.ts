import { join } from 'node:path'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import type { MachineDispatchResult } from '@shared/types/machine-dispatch.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { recordDecisionAndWait } from '../security/decision-log-store.ts'

export interface AcpToolContinuation {
  operationId: string
  owner: ThreadExecutionOwner
  turnTreeId: string
  toolName: string
  alreadyObserved?: () => boolean
}

export interface AcpToolCompletion extends AcpToolContinuation {
  result: string
}

export type AcpToolCompletionHandler = (
  completion: AcpToolContinuation,
  prompt: string,
) => Promise<MachineDispatchResult>

let handler: AcpToolCompletionHandler | null = null

export function setAcpToolCompletionHandler(next: AcpToolCompletionHandler | null): void {
  handler = next
}

/** Capture the host at request start, before the owning turn releases its context. */
export function resolveAcpToolCompletionHandler(): AcpToolCompletionHandler | null {
  return handler
}

/**
 * The operation already ran. Save its output before waking the agent; delivery
 * must never execute the tool again. The dispatcher owns epoch, budget and dedupe.
 */
export async function recoverAcpToolCompletion(
  completion: AcpToolCompletion,
  armedHandler: AcpToolCompletionHandler | null,
): Promise<void> {
  const decision = await recordDecisionAndWait({
    projectId: completion.owner.projectId,
    threadId: completion.owner.threadId,
    kind: 'bridge-result',
    actor: 'system',
    verdict: 'classified',
    subject: completion.toolName,
    bridgeExecutionId: completion.operationId,
    source: 'acp-native-bridge',
    detail: { result: completion.result },
  })
  if (!decision?.line.detail || !armedHandler) return
  const path = join(
    projectStoreDir(completion.owner.projectId),
    completion.owner.threadId,
    decision.line.detail.ref,
  )
  const prompt =
    `The ${completion.toolName} call completed after its original caller detached. ` +
    'The action already ran; do not repeat it. Use its result to continue the original task.\n' +
    `The full result is saved at ${path}.\n` +
    wrapExternalContent(completion.toolName, completion.result.slice(0, 16_000))
  await armedHandler(completion, prompt)
}
