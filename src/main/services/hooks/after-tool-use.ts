// afterToolUse orchestration (D2) — fires the canonical `afterToolUse` event
// after each tool result. Cursor's dedicated `afterShellExecution` /
// `afterMCPExecution` and generic `postToolUse` / `postToolUseFailure` are wire
// flavors of this one canonical event, the same way `toolGate` unifies the
// before-shell/MCP/read gates.
//
// **Detached async — no drain barrier (decision 3).** Same shape as `stop.ts`:
// the fire site dispatches through the shared {@link AsyncHookDispatcher} via
// {@link HookRegistry.emitAsync}, which returns synchronously and never awaits
// the hook — so a slow observation hook can never delay the agent loop. Every
// dispatch carries the emitting turn-tree id (decision 16), supplied by the
// fire site.
//
// **Post-hoc only (decision 3 / plan D2 row).** Cursor's after-events are
// fire-and-forget and cannot change the completed tool call. A generic
// `postToolUse` hook may return `additional_context`; the adapter turns that into
// a queued message for the next model boundary. This module carries no return
// the caller must consume — it resolves to a count plus a `settled` promise
// purely so a test can await completion and assert the event fired.
//
// **Capped output snapshot.** A tool's stdout / result is unbounded; dumping it
// verbatim into a hook's stdin is a known D2 trap. {@link runAfterToolUseHooks}
// caps `payload.output` to {@link AFTER_TOOL_USE_OUTPUT_CAP} before dispatch, so
// the wire payload the adapter marshals is always bounded.
//
// Cursor declares both after-events and Claude a `PostToolUse` hook; all are
// wired here, per the vendor audit in docs/plans/hooks-and-feature-packs.md.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorAfterToolUseHooks } from './cursor-adapter.ts'
import { claudeAfterToolUseHooks } from './claude-adapter.ts'
import { copseAfterToolUseHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import type { HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'

/**
 * Cap the tool-output snapshot marshalled into a hook's stdin (D2). A tool's
 * stdout / MCP result can be arbitrarily large; the observation only needs a
 * representative slice, so the payload is truncated with a marker. Sized well
 * under the spawn machinery's 1 MB stdin/stdout cap so the wire payload never
 * approaches it. Kept here (the fire-side owner of the snapshot) rather than in
 * `packages/agent`, which stays free of host-side sizing policy.
 */
export const AFTER_TOOL_USE_OUTPUT_CAP = 16_000

const OUTPUT_TRUNCATION_MARKER = '\n…[output truncated for afterToolUse hook]'

/** Truncate an output snapshot to the cap, appending a marker when it overflows. */
export function capToolOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  if (output.length <= AFTER_TOOL_USE_OUTPUT_CAP) return output
  return output.slice(0, AFTER_TOOL_USE_OUTPUT_CAP) + OUTPUT_TRUNCATION_MARKER
}

/** What the tool-result fire site learns from the `afterToolUse` hooks. */
export interface AfterToolUseResult {
  /**
   * How many `afterToolUse` hooks matched (the shell/MCP flavor for this tool)
   * and were dispatched. Observation-only + detached, so there is no decision to
   * surface — the count lets the fire site know work was dispatched and lets a
   * test assert the event fired.
   */
  ran: number
  /**
   * Resolves when the dispatched hooks have finished. **A test affordance
   * only** — production never awaits it, because a slow observation hook must
   * never delay the loop (decision 3, no drain barrier). Resolves immediately
   * when nothing matched.
   */
  settled: Promise<void>
}

/** Options the tool-result fire site passes to {@link runAfterToolUseHooks}. */
export type RunAfterToolUseHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /**
   * Recording context snapshotted synchronously at the fire site so a detached
   * `afterToolUse` hook's `hook_run` spine line survives `endHookRunRecording`
   * (decision 3/6). Without it the record is dropped or misattributed.
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Discover + fire every dialect's post-tool observation command hooks for this
 * tool result (Cursor's dedicated and generic post-tool flavors),
 * **dispatched through the detached async executor** (C1, decision 3 — never
 * awaited). Caps the output snapshot before dispatch so an unbounded tool result
 * never reaches a hook's stdin. Returns `{ ran: 0 }` when nothing is registered,
 * so the default path is unchanged.
 *
 * Cursor's generic success event may return `additional_context`, which the
 * adapter routes through `onAsyncOutcome` as a queued message (C2). The same
 * sink lets a first-party *async function* hook on this mid-turn event route a
 * `queueMessage` or a `haltRun` (H3, decision 12 — halt the current turn through
 * the abort path).
 */
export async function runAfterToolUseHooks(
  payload: HookEventPayloads['afterToolUse'],
  opts: RunAfterToolUseHooksOpts,
): Promise<AfterToolUseResult> {
  const cappedOutput = capToolOutput(payload.output)
  const cappedPayload: HookEventPayloads['afterToolUse'] = {
    ...payload,
    ...(cappedOutput !== undefined ? { output: cappedOutput } : {}),
  }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    ...(opts.executionRoot !== undefined ? { executionRoot: opts.executionRoot } : {}),
    projectTrusted: opts.projectTrusted,
  }
  const [cursorHooks, claudeHooks, copseHooks] = await Promise.all([
    cursorAfterToolUseHooks(cappedPayload, discoverOpts),
    claudeAfterToolUseHooks(cappedPayload, discoverOpts),
    copseAfterToolUseHooks(cappedPayload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...claudeHooks, ...copseHooks]
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  // Detached dispatch (decision 3): `emitAsync` schedules each hook on the
  // shared dispatcher and returns immediately — it never awaits. The detached
  // run context strips the abort signal, so an in-flight hook is never killed.
  // Every dispatch carries the emitting `turnTreeId` (decision 16). The
  // `onAsyncOutcome` sink routes a `queueMessage` (C2) / `haltRun` (H3) an async
  // function hook returns, and carries generic Cursor `additional_context` to
  // the next model boundary.
  registry.emitAsync('afterToolUse', cappedPayload, {
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
