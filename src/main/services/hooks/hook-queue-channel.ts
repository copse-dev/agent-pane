// Hook → pending-message queue channel (C2) — the host side of decision 4.
//
// The pending-message queue is the **only** async output channel (decision 4).
// An async hook's `queueMessage` outcome, collected by the detached executor's
// `onAsyncOutcome` sink (C1), is translated here into the renderer IPC payload
// and forwarded to the window; the renderer lands it in the thread's queue with
// origin attribution (decision 10) and epoch (decision 16), where the staleness
// check + held downgrade live (`enqueueHookMessage` in the renderer).
//
// Module layout (execution-guidance rule 4): the queue *policy* (drain-skip,
// held, staleness) is renderer-side; this host module only bridges an async
// outcome to that renderer entry point. The window sender is a process-wide
// singleton (mirroring `getAsyncHookDispatcher`) so the per-emit fire sites
// (`stop.ts`, future async events) can wire `onAsyncOutcome` without threading a
// `BrowserWindow` down every call.
import type { AsyncOutcomeRecord } from '@copse/agent/hooks/hook-registry.ts'
import type { HookQueueMessagePayload } from '@shared/types/hooks.ts'

/** How this module reaches the renderer; set once at window creation. */
export type HookQueueMessageSender = (payload: HookQueueMessagePayload) => void

let sender: HookQueueMessageSender | null = null

/**
 * Register the renderer sender (main → renderer over `agent:hook_queue_message`).
 * Called from window setup; a headless host (unit test) leaves it unset, in which
 * case emitted messages are dropped rather than crashing.
 */
export function setHookQueueMessageSender(fn: HookQueueMessageSender | null): void {
  sender = fn
}

/**
 * Forward one async hook outcome's `queueMessage` to the renderer queue. A
 * no-op when the outcome carries no `queueMessage` (e.g. a `stop` notification,
 * or a `haltRun`-only outcome — `haltRun` routing is H3, and a *stale* async
 * `haltRun` is a suppressed no-op per decision 16, which "do nothing here" also
 * satisfies until H3 wires the abort path). Also a no-op with no sender wired.
 */
export function forwardHookQueueMessage(record: AsyncOutcomeRecord, threadId: string): void {
  const queueMessage = record.outcome.queueMessage
  if (!queueMessage) return
  if (!sender) return
  sender({
    threadId,
    text: queueMessage.text,
    sendNow: queueMessage.sendNow,
    origin: { kind: 'hook', hookId: record.hookId, event: record.event },
    // The dispatch epoch (decision 16) rides on the outcome record from C1; the
    // renderer compares it against the thread's current turn tree.
    epoch: record.turnTreeId,
  })
}

/**
 * Build the `onAsyncOutcome` sink an async fire site hands to
 * `HookRegistry.emitAsync`. Bound to the emitting thread so the renderer knows
 * which queue to land the message in. C1 tags every outcome with its epoch, so
 * a late output stays attributable to its turn tree (decision 16).
 */
export function hookQueueOutcomeSink(threadId: string): (record: AsyncOutcomeRecord) => void {
  return (record) => {
    forwardHookQueueMessage(record, threadId)
  }
}
