// permissionDecision orchestration (F2, Copse-native) — fires the canonical
// `permissionDecision` event **after** the permission gate has decided a verdict.
//
// This is a clean, observation-only notification (decision 3): the verdict has
// already happened, so a hook here can never change it. It exists so an audit
// logger — PR #840's permission decision-log-store — can become a **subscriber**
// of the canonical event rather than yet another inline integration bolted onto
// `permission-gate.ts` (the "one canonical event, N subscribers" goal in the
// Codebase-impact section). This stack does **not** depend on #840: we emit a
// clean observation an audit logger could consume once it lands.
//
// Same detached shape as `stop.ts` / `subagent.ts`'s stop path: discover the
// matching Copse command hooks (matcher on the gated tool name), register them
// on a fresh registry, and dispatch through the shared {@link AsyncHookDispatcher}
// via `emitAsync` — **never awaited**, so observing a verdict can never delay the
// tool that was gated. A `queueMessage` follow-up routes through the pending-
// message queue (decision 4).
//
// **Copse-native.** Cursor and Claude declare no permission-decision hook, so
// only the Copse adapter participates (the runner abstains for a dialect with no
// marshaller).
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { HookDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { copsePermissionDecisionHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import type { HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/** What the permission-gate fire site learns from the `permissionDecision` hooks. */
export interface PermissionDecisionResult {
  /** How many hooks matched and were dispatched (detached). */
  ran: number
  /**
   * Resolves when the dispatched hooks have finished — **a test affordance
   * only**, never awaited in production (decision 3, no drain barrier).
   */
  settled: Promise<void>
}

/** Options the permission-gate fire site passes to {@link runPermissionDecisionHooks}. */
export type RunPermissionDecisionHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /**
   * Recording context snapshotted synchronously at the fire site so a detached
   * hook's `hook_run` spine line survives `endHookRunRecording` (decision 3/6).
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's `permissionDecision` command hooks (matcher on
 * the gated tool name) with the verdict, **dispatched through the detached async
 * executor** (C1, decision 3 — never awaited). Returns `{ ran: 0 }` when nothing
 * matches. The `decision` is the canonical {@link HookDecision} the gate mapped
 * from its own verdict (a shell `prompt` becomes `ask`).
 */
export async function runPermissionDecisionHooks(
  toolName: string,
  decision: HookDecision,
  opts: RunPermissionDecisionHooksOpts,
): Promise<PermissionDecisionResult> {
  const payload: HookEventPayloads['permissionDecision'] = { toolName, decision }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await copsePermissionDecisionHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  registry.emitAsync('permissionDecision', payload, {
    dispatcher,
    threadId: opts.threadId,
    turnTreeId: opts.turnTreeId,
    runCommandHook: createCommandHookRunner(
      opts.recordingSnapshot !== undefined ? { recordingSnapshot: opts.recordingSnapshot } : {},
    ),
    onAsyncOutcome: hookQueueOutcomeSink(opts.threadId, opts.recordingSnapshot),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length, settled: dispatcher.whenIdle(opts.threadId) }
}
