// Diff-queue hook orchestration (F2, Copse-native) — fires `beforeDiffApply`
// (blocking) before a queued/direct diff lands and `afterDiffApply` (async,
// detached) once a queued diff reaches a terminal decision.
//
// `beforeDiffApply` mirrors `subagent.ts`'s `runSubagentStartHooks` (blocking
// decision): discover the matching Copse command hooks (glob on the diff's
// path), register them on a fresh registry, fire through the shared
// registry → runner → adapter seam, and reduce to a single decision. A `deny`
// (Cursor's `permission: deny`, or `ask`, which the diff-apply gate treats as
// deny) or a `haltRun` blocks the apply — the fire site turns that into a
// failed `ApplyResult` so the diff stays queued for retry.
//
// `afterDiffApply` mirrors `stop.ts` (detached async, decision 3): dispatched
// through the shared {@link AsyncHookDispatcher} via `emitAsync` and **never
// awaited**, so a slow observer can never delay the diff-queue UI. A
// `queueMessage` follow-up routes through the pending-message queue (C2/C3) via
// the same `onAsyncOutcome` sink, never a bespoke protocol (decision 4).
//
// Both events are **Copse-native**: Cursor and Claude declare no diff-queue
// hook, so only the Copse adapter participates (the runner abstains for a
// dialect with no marshaller). #840's permission audit trail is a separate
// event (`permissionDecision`); these two are the diff-approval flow.
import { HookRegistry, mergeBlockingOutcomes } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { copseBeforeDiffApplyHooks, copseAfterDiffApplyHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import type { HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { withRunDeadlinePaused } from './run-deadline.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/** The decision reduced from the `beforeDiffApply` gate hooks. */
export interface BeforeDiffApplyDecision {
  /** True when a hook blocked the apply (`deny`/`ask`, or a `haltRun`). */
  blocked: boolean
  /** Message a hook wants fed to the agent, if any. */
  agentMessage?: string
  /** Message a hook wants shown to the user (hook card), if any. */
  userMessage?: string
}

/**
 * Discover + fire every dialect's `beforeDiffApply` command hooks (glob on the
 * diff's path) and reduce them to a single decision. Returns `{ blocked: false }`
 * when nothing matches, so the default apply path is unchanged. Firing goes
 * through the canonical `beforeDiffApply` registry event.
 *
 * `filePath` is the **absolute** path of the file the diff targets (the canonical
 * payload shape); the adapter's glob derives the workspace-relative form.
 */
export async function runBeforeDiffApplyHooks(
  filePath: string,
  opts: DialectDiscoverOpts & { signal?: AbortSignal; agentSession?: AgentSessionInfo },
): Promise<BeforeDiffApplyDecision> {
  const payload: HookEventPayloads['beforeDiffApply'] = { filePath }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await copseBeforeDiffApplyHooks(payload, discoverOpts)
  if (hooks.length === 0) return { blocked: false }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  // H4 (decision 13): pause the run's idle deadline while the blocking gate hooks
  // are awaited. beforeDiffApply fires inside a tool's execution (already paused);
  // the reference-counted deadline composes safely.
  const { outcomes } = await withRunDeadlinePaused(opts.agentSession?.conversationId, () =>
    registry.emit('beforeDiffApply', payload, {
      runCommandHook: createCommandHookRunner(),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
    }),
  )
  const merged = mergeBlockingOutcomes(outcomes)

  // `ask` is normalized to `deny` by the adapter (a diff apply cannot pause a
  // spawned hook for interactive approval), so a `deny`/`haltRun` blocks the apply.
  const blocked = merged.decision === 'deny' || merged.haltRun !== undefined
  return {
    blocked,
    ...(merged.agentMessage !== undefined ? { agentMessage: merged.agentMessage } : {}),
    ...(merged.userMessage !== undefined ? { userMessage: merged.userMessage } : {}),
  }
}

/** What the terminal-decision fire site learns from the `afterDiffApply` hooks. */
export interface AfterDiffApplyResult {
  /** How many `afterDiffApply` hooks matched and were dispatched (detached). */
  ran: number
  /**
   * Resolves when the dispatched hooks have finished — **a test affordance
   * only**, never awaited in production (decision 3, no drain barrier).
   */
  settled: Promise<void>
}

/** Options the terminal-decision fire site passes to {@link runAfterDiffApplyHooks}. */
export type RunAfterDiffApplyHooksOpts = DialectDiscoverOpts & {
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
 * Discover + fire every dialect's `afterDiffApply` command hooks with the diff's
 * path + `applied` flag, **dispatched through the detached async executor** (C1,
 * decision 3 — never awaited). A `queueMessage` follow-up routes through the
 * pending-message queue via `onAsyncOutcome`. Returns `{ ran: 0 }` when nothing
 * matches.
 */
export async function runAfterDiffApplyHooks(
  payload: HookEventPayloads['afterDiffApply'],
  opts: RunAfterDiffApplyHooksOpts,
): Promise<AfterDiffApplyResult> {
  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  const hooks = await copseAfterDiffApplyHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  registry.emitAsync('afterDiffApply', payload, {
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
