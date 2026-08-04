import type { MachineDispatchResult } from '../agent-dispatcher.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'

export interface BackgroundCompletionWakeRequest {
  operationId: string
  owner: ThreadExecutionOwner
  turnTreeId: string
  exitCode: number | null
  timedOut: boolean
}

type BackgroundCompletionWakeHandler = (
  request: BackgroundCompletionWakeRequest,
) => Promise<MachineDispatchResult>

let handler: BackgroundCompletionWakeHandler | null = null

export function setBackgroundCompletionWakeHandler(
  next: BackgroundCompletionWakeHandler | null,
): void {
  handler = next
}

export async function requestBackgroundCompletionWake(
  request: BackgroundCompletionWakeRequest,
): Promise<MachineDispatchResult> {
  if (!handler) return 'stale'
  return handler(request)
}
