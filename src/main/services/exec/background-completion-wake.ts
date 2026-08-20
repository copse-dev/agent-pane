import { AsyncLocalStorage } from 'node:async_hooks'
import type { MachineDispatchResult } from '../agent-dispatcher.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'

export interface BackgroundCompletionWakeRequest {
  operationId: string
  owner: ThreadExecutionOwner
  turnTreeId: string
  exitCode: number | null
  timedOut: boolean
}

export type BackgroundCompletionWakeHandler = (
  request: BackgroundCompletionWakeRequest,
) => Promise<MachineDispatchResult>

let handler: BackgroundCompletionWakeHandler | null = null
const scopedHandler = new AsyncLocalStorage<BackgroundCompletionWakeHandler>()

export function setBackgroundCompletionWakeHandler(
  next: BackgroundCompletionWakeHandler | null,
): void {
  handler = next
}

export function runWithBackgroundCompletionWakeHandler<T>(
  next: BackgroundCompletionWakeHandler,
  fn: () => T,
): T {
  return scopedHandler.run(next, fn)
}

/**
 * Snapshot the handler that should receive a later completion wake.
 *
 * Child-process `exit` callbacks are not guaranteed to stay inside the
 * `AsyncLocalStorage` scope that armed the wake. Capture at arm time so the
 * EventEmitter path still reaches the same handler the turn installed.
 */
export function resolveBackgroundCompletionWakeHandler(): BackgroundCompletionWakeHandler | null {
  return scopedHandler.getStore() ?? handler
}

export async function requestBackgroundCompletionWake(
  request: BackgroundCompletionWakeRequest,
  armedHandler: BackgroundCompletionWakeHandler | null = resolveBackgroundCompletionWakeHandler(),
): Promise<MachineDispatchResult> {
  if (!armedHandler) return 'stale'
  return armedHandler(request)
}

export function backgroundCompletionPrompt(request: BackgroundCompletionWakeRequest): string {
  const status = request.timedOut
    ? 'reached its deadline'
    : request.exitCode === null
      ? 'ended without an exit code'
      : `exited with code ${String(request.exitCode)}`
  return `Background task ${request.operationId} ${status}. Inspect its retained output with run_background logs, then continue the original task and report the result. Do not rerun the completed command.`
}
