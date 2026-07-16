// postTurnReview orchestration (F2, Copse-native) — fires the canonical
// `postTurnReview` event after a post-turn review cycle produces a verdict
// (E3's `runPostTurnReviewCycle` seam).
//
// Observation-only (decision 3): the review already ran and applied its todo
// patches, so a hook here observes the verdict (`issuesFound` + `summary`)
// without gating the turn — useful for a Copse-native pack that reacts to what
// the reviewer found (e.g. notifying, logging, or queuing a follow-up). Skips
// (empty diff / spend not approved) never fire this, because no review ran.
//
// Same detached shape as `stop.ts`: discover the matching Copse command hooks,
// register on a fresh registry, and dispatch through the shared
// {@link AsyncHookDispatcher} via `emitAsync` — **never awaited**, so a slow
// observer can never delay the run's terminal `done`. A `queueMessage` follow-up
// routes through the pending-message queue (decision 4).
//
// **Copse-native.** Cursor and Claude declare no post-turn-review hook, so only
// the Copse adapter participates (the runner abstains for a dialect with no
// marshaller).
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { copsePostTurnReviewHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/** What the review fire site learns from the `postTurnReview` hooks. */
export interface PostTurnReviewHookResult {
  /** How many hooks matched and were dispatched (detached). */
  ran: number
  /**
   * Resolves when the dispatched hooks have finished — **a test affordance
   * only**, never awaited in production (decision 3, no drain barrier).
   */
  settled: Promise<void>
}

/** Options the review fire site passes to {@link runPostTurnReviewHooks}. */
export type RunPostTurnReviewHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's `postTurnReview` command hooks with the
 * verdict, **dispatched through the detached async executor** (C1, decision 3 —
 * never awaited). Returns `{ ran: 0 }` when nothing matches.
 */
export async function runPostTurnReviewHooks(
  payload: HookEventPayloads['postTurnReview'],
  opts: RunPostTurnReviewHooksOpts,
): Promise<PostTurnReviewHookResult> {
  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await copsePostTurnReviewHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  registry.emitAsync('postTurnReview', payload, {
    dispatcher,
    threadId: opts.threadId,
    turnTreeId: opts.turnTreeId,
    runCommandHook: createCommandHookRunner(),
    onAsyncOutcome: hookQueueOutcomeSink(opts.threadId),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length, settled: dispatcher.whenIdle(opts.threadId) }
}
