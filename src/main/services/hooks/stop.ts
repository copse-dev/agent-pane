// stop orchestration (B3) — fires the canonical `stop` event the moment agent
// work stops: normal turn completion (`status: 'completed'`) or abort
// (`status: 'aborted'`).
//
// Same shape as `after-file-edit.ts` and `before-submit-prompt.ts`: the fire
// site (agent-service.ts, at each turn's end) calls {@link runStopHooks} with
// the terminal status; we discover the matching Cursor command hooks, register
// them on a fresh registry, and fire `stop` through the shared
// registry → runner → adapter seam.
//
// **Detached async — no drain barrier (decision 3).** The fire site dispatches
// `stop` and never awaits it: `void runStopHooks(...)`. Abort / turn-end halts
// emission of *new* events but never kills or waits for in-flight hooks, so a
// slow `stop` hook can never delay the turn's `done`, and it may still be
// running while observation hooks from earlier steps run.
//
// **C1 — the real detached executor.** B3 shipped a minimal fire-and-forget
// dispatch (`await registry.emit`, awaited only inside the un-awaited
// `runStopHooks`). C1 generalizes it: `stop` now dispatches through the shared
// {@link AsyncHookDispatcher} (per-thread concurrency cap + pending FIFO,
// decision 13) via {@link HookRegistry.emitAsync}, which returns synchronously
// and never awaits the hook (decision 3). Every dispatch carries the emitting
// turn-tree id (decision 16), supplied by the fire site. This module therefore
// carries no control-flow return the caller must consume — it resolves to a
// count plus a `settled` promise purely so a test can await completion and
// assert the event fired. See docs/plans/hooks-and-feature-packs.md (C1 row,
// decisions 3, 13, 16).
//
// **Follow-ups via C2, not a bespoke protocol (decision 4).** Cursor's `stop` is
// notification-only (it carries `status` and returns nothing), so it never
// produces one. Claude's `Stop` does: it can return `decision: "block"` with a
// reason meaning "don't stop, keep going". A detached dispatch cannot resume a
// finished turn, so that reason is *not* turned into a bespoke continuation —
// it routes through the pending-message queue via `onAsyncOutcome` below (C2,
// which owns origin attribution + the held state), like every other async
// follow-up.
//
// Cursor declares a `stop` hook and Claude a `Stop` hook; both are wired here.
// Claude's `Stop` can ask the agent to keep going, which a detached dispatch
// cannot honour — its block `reason` routes through the queue above instead.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorStopHooks } from './cursor-adapter.ts'
import { claudeStopHooks } from './claude-adapter.ts'
import { copseStopHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import type { HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/** What the turn-end / abort fire site learns from the stop hooks. */
export interface StopResult {
  /**
   * How many `stop` hooks matched and were dispatched. `stop` is
   * notification-only and detached, so there is no decision to surface — the
   * count is enough for the fire site to know work was dispatched and for tests
   * to assert the event fired.
   */
  ran: number
  /**
   * Resolves when the dispatched `stop` hooks have finished (the dispatcher's
   * thread state has drained). **A test affordance only** — production never
   * awaits it (`void runStopHooks(...)`), because a slow `stop` hook must never
   * delay the turn's `done` (decision 3, no drain barrier). Resolves immediately
   * when nothing matched.
   */
  settled: Promise<void>
}

/** Options the turn-end / abort fire site passes to {@link runStopHooks}. */
export type RunStopHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /**
   * Recording context snapshotted synchronously at the fire site so the
   * detached `stop` hook's `hook_run` spine line survives `endHookRunRecording`
   * (decision 3/6). Without it the record is dropped or misattributed.
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's `stop` command hooks with the terminal
 * `status`, **dispatched through the detached async executor** (C1). Returns
 * `{ ran: 0, settled: resolved }` when nothing matches. Firing goes through the
 * canonical `stop` registry event via `emitAsync`, so this is exactly the seam
 * later async events extend — the adapters are the only dialect-aware code.
 *
 * The hook execution is **never awaited**: `emitAsync` schedules each hook on the
 * shared dispatcher (per-thread concurrency cap + pending FIFO, decision 13) and
 * returns synchronously; a slow `stop` hook can never delay the turn's `done`
 * (decision 3). Every dispatch carries `turnTreeId` (decision 16). The returned
 * promise resolves after *discovery + scheduling* — awaiting it does not gate the
 * turn; use `settled` (a test affordance) to await actual hook completion.
 */
export async function runStopHooks(
  status: HookEventPayloads['stop']['status'],
  opts: RunStopHooksOpts,
): Promise<StopResult> {
  const payload: HookEventPayloads['stop'] = { status }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  // All three dialects declare a run-end hook: Cursor's `stop`, Claude's `Stop`,
  // and Copse's native event (F1). Discovery is not gated on any abort signal —
  // decision 3 says a `stop` dispatched at turn end / abort runs to its own
  // completion.
  const [cursorHooks, claudeHooks, copseHooks] = await Promise.all([
    cursorStopHooks(payload, discoverOpts),
    claudeStopHooks(payload, discoverOpts),
    copseStopHooks(payload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...claudeHooks, ...copseHooks]
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  // Detached dispatch (decision 3): `emitAsync` schedules each `stop` hook on the
  // shared dispatcher and returns immediately — it never awaits; the command
  // runner records the spine line and resolves dialect failure internally. The
  // detached run context strips the abort signal, so an in-flight stop hook is
  // never killed (see `detachedHookContext`). Every dispatch carries the
  // emitting `turnTreeId` (decision 16). The fire site captured the session by
  // value before dispatching, so a slow stop hook still marshals the finished
  // turn's identity (B4).
  registry.emitAsync('stop', payload, {
    dispatcher,
    threadId: opts.threadId,
    turnTreeId: opts.turnTreeId,
    runCommandHook: createCommandHookRunner(
      opts.recordingSnapshot !== undefined ? { recordingSnapshot: opts.recordingSnapshot } : {},
    ),
    // C2: a `queueMessage` outcome lands in the renderer's pending queue via this
    // sink (decision 4) — an async function hook's, or a Claude `Stop` hook's
    // block `reason`, which is the one thing a run-end command hook can return
    // that Copse can still act on. Cursor's `stop` is notification-only and never
    // produces one. A stale send-now is downgraded to held on the renderer side
    // (decision 16).
    onAsyncOutcome: hookQueueOutcomeSink(opts.threadId, opts.recordingSnapshot),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length, settled: dispatcher.whenIdle(opts.threadId) }
}
