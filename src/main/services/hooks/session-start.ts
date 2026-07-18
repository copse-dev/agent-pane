// sessionStart orchestration (H4) — fires the canonical `sessionStart` event on
// a thread's first turn (a new composer conversation), fire-and-forget.
//
// Same shape as `stop.ts`: the fire site (agent-service.ts, at the top of a
// run) calls {@link fireSessionStartHook}; we discover the matching Cursor +
// Claude session-start command hooks, register them on a fresh registry, and
// dispatch `sessionStart` through the shared registry → dispatcher → runner →
// adapter seam via {@link HookRegistry.emitAsync}.
//
// **Fire-and-forget (decision 3).** `sessionStart` is async: `emitAsync`
// schedules each hook on the shared detached dispatcher (per-thread concurrency
// cap + FIFO, decision 13) and returns synchronously. A slow `sessionStart`
// hook can never delay the turn. Every dispatch carries the emitting
// `turnTreeId` (decision 16).
//
// **`sessionEnv` propagation (the H4 payload).** A `sessionStart` hook's `env`
// output (Cursor's output field) is collected into the per-session env store
// (`session-env.ts`) by this module's outcome sink; the command-hook runner
// then layers it onto the child env of every *later* hook it spawns for the
// session (`hook-spawn.ts`). Timing is best-effort by nature — a hook that
// spawns before the store is populated simply misses the vars, matching the
// vendor's documented behavior — because nothing ever waits on a detached
// dispatch. Claude propagates env via `$CLAUDE_ENV_FILE` (a file, not a JSON
// stdout field); that file-based path is deferred (H4 row in the plan doc), so
// only Cursor's `env` output feeds the store today.
//
// Module layout (execution-guidance rule 4): the fire site is a host concern
// (it owns the run, the settings gate, and the session identity); `packages/agent`
// stays Electron-free and only carries the canonical event + async outcome type.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AsyncOutcomeRecord } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { AsyncHookDispatcher } from '@copse/agent/hooks/async-dispatcher.ts'
import { errorMessage } from '@shared/errors.ts'
import { getSetting } from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from '../security/workspace-trust.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorSessionStartHooks } from './cursor-adapter.ts'
import { claudeSessionStartHooks } from './claude-adapter.ts'
import { copseSessionStartHooks } from './copse-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'
import { snapshotHookRunContext, type HookRunRecordingSnapshot } from '../hook-run-recorder.ts'
import { getAsyncHookDispatcher } from './async-hook-dispatcher.ts'
import { hookQueueOutcomeSink } from './hook-queue-channel.ts'
import { currentAgentSessionInfo } from './agent-session.ts'
import { mergeSessionEnv, clearSessionEnv } from './session-env.ts'

/** What the run-start fire site learns from the session-start hooks. */
export interface SessionStartResult {
  /**
   * How many `sessionStart` hooks matched and were dispatched. `sessionStart`
   * is fire-and-forget, so there is no decision to surface — the count lets the
   * fire site (and tests) know work was dispatched.
   */
  ran: number
  /**
   * Resolves when the dispatched `sessionStart` hooks have finished (the
   * dispatcher's thread state drained). **A test affordance only** — production
   * never awaits it, because a slow `sessionStart` hook must never delay the
   * turn (decision 3). Resolves immediately when nothing matched.
   */
  settled: Promise<void>
}

/** Options the run-start fire site passes to {@link runSessionStartHooks}. */
export type RunSessionStartHooksOpts = DialectDiscoverOpts & {
  /** Thread the concurrency cap + FIFO are scoped to (decision 13). */
  threadId: string
  /** Emitting turn-tree epoch, carried on every dispatch (decision 16). */
  turnTreeId: TurnTreeId
  /** Session identity captured by value at the fire site (B4 + decision 3). */
  agentSession?: AgentSessionInfo
  /**
   * Recording context snapshotted synchronously at the fire site so a detached
   * `sessionStart` hook's `hook_run` spine line survives `endHookRunRecording`
   * (decision 3/6). Without it the record is dropped or misattributed.
   */
  recordingSnapshot?: HookRunRecordingSnapshot | null
  /** Detached executor; defaults to the process-wide shared instance. */
  dispatcher?: AsyncHookDispatcher
}

/**
 * Build the `onAsyncOutcome` sink for `sessionStart`: collect each hook's
 * `sessionEnv` into the per-session env store (H4) so later hook spawns inherit
 * it, and delegate the queue-message / halt channels to the shared sink so a
 * `sessionStart` hook that also queues a message behaves like any other async
 * hook (decision 4). Bound to the emitting thread — the store and the queue are
 * both keyed by it.
 */
export function sessionStartOutcomeSink(
  threadId: string,
  recordingSnapshot?: HookRunRecordingSnapshot | null,
): (record: AsyncOutcomeRecord) => void {
  const queueSink = hookQueueOutcomeSink(threadId, recordingSnapshot)
  return (record) => {
    if (record.outcome.sessionEnv) mergeSessionEnv(threadId, record.outcome.sessionEnv)
    queueSink(record)
  }
}

/**
 * Discover + fire every dialect's `sessionStart` command hooks, **dispatched
 * through the detached async executor** (decision 3). Returns
 * `{ ran: 0, settled: resolved }` when nothing matches. Firing goes through the
 * canonical `sessionStart` registry event via `emitAsync`, so the adapters are
 * the only dialect-aware code. The hook execution is **never awaited**; use
 * `settled` (a test affordance) to await actual completion.
 */
export async function runSessionStartHooks(
  payload: HookEventPayloads['sessionStart'],
  opts: RunSessionStartHooksOpts,
): Promise<SessionStartResult> {
  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  // Every wired dialect can declare a session-start hook (Cursor's
  // `sessionStart`, Claude's `SessionStart`, Copse's `sessionStart`). Discovery
  // is not gated on any abort signal — decision 3 says a detached hook runs to
  // its own completion.
  const [cursorHooks, claudeHooks, copseHooks] = await Promise.all([
    cursorSessionStartHooks(payload, discoverOpts),
    claudeSessionStartHooks(payload, discoverOpts),
    copseSessionStartHooks(payload, discoverOpts),
  ])
  const hooks = [...cursorHooks, ...claudeHooks, ...copseHooks]
  if (hooks.length === 0) return { ran: 0, settled: Promise.resolve() }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  const dispatcher = opts.dispatcher ?? getAsyncHookDispatcher()

  registry.emitAsync('sessionStart', payload, {
    dispatcher,
    threadId: opts.threadId,
    turnTreeId: opts.turnTreeId,
    runCommandHook: createCommandHookRunner(
      opts.recordingSnapshot !== undefined ? { recordingSnapshot: opts.recordingSnapshot } : {},
    ),
    // Collects each hook's `env` into the session store (H4) and forwards any
    // queue-message / halt through the shared channel (decision 4).
    onAsyncOutcome: sessionStartOutcomeSink(opts.threadId, opts.recordingSnapshot),
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length, settled: dispatcher.whenIdle(opts.threadId) }
}

/**
 * Fire `sessionStart` at the top of a run (H4). Gated behind `cursorHooksEnabled`
 * (default off) — the same flag every wired hook fire site uses — and only fires
 * on the thread's **first turn** (`firstTurn`), which is Copse's new-conversation
 * trigger. Detached and never awaited (`void`): a slow `sessionStart` hook can
 * never delay the turn (decision 3). The session env store is cleared first so a
 * prior conversation's exported vars never leak into a fresh session. Any
 * dispatch error is swallowed — a broken session-start hook must never fail the
 * run it precedes.
 */
export function fireSessionStartHook(
  threadId: string,
  opts: { firstTurn: boolean; turnTreeId: TurnTreeId },
): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  if (!opts.firstTurn) return
  const workspaceRoot = getWorkspaceRoot()
  // A fresh session starts with no inherited env; re-collect on this first turn.
  clearSessionEnv(threadId)
  // Capture the agent-session identity by value now — the hook dispatches
  // detached (decision 3) and may marshal after this run's recording context is
  // set up/torn down. `conversationId` is the thread id (B4).
  const agentSession = currentAgentSessionInfo({ conversationId: threadId })
  // Snapshot the recording context now, synchronously, like `fireStopHook`: a
  // detached `sessionStart` hook may settle after this run's recording window
  // closes, and its `hook_run` line must still attribute to the emitting turn
  // (decision 3/6).
  const recordingSnapshot = snapshotHookRunContext()
  const payload: HookEventPayloads['sessionStart'] = { firstTurn: opts.firstTurn }
  void runSessionStartHooks(payload, {
    threadId,
    turnTreeId: opts.turnTreeId,
    workspaceRoot,
    projectTrusted: isWorkspaceTrusted(workspaceRoot),
    agentSession,
    recordingSnapshot,
  }).catch((err: unknown) => {
    console.warn('[hooks] sessionStart hook dispatch error:', errorMessage(err))
  })
}
