// Run-deadline pause registry (H4, decision 13) — lets host-side blocking hook
// fire sites pause the active run's sliding **idle** deadline while a blocking
// hook is awaited, "the same way tool execution does".
//
// The idle deadline (`AgentRunDeadline`, `packages/agent`) already pauses around
// tool execution and LLM streaming (see `run-agent-loop.ts`). A blocking hook
// can legitimately run for a long time (a Claude `command` hook defaults to
// 600s), so awaiting one must not advance the idle clock — decision 13:
// "Blocking-hook wait pauses the idle deadline the same way tool execution
// does." The deadline lives inside the loop, but the blocking hooks fire from
// host code (the permission gate, the compose path, the subagent spawn gate,
// the diff-queue write site). This registry bridges that gap exactly like
// `halt-run.ts` bridges the abort path: the run registers its deadline on start
// (keyed by thread id) and clears it on end, and a fire site wraps its hook
// wait in {@link withRunDeadlinePaused}.
//
// Nested pause is safe: `AgentRunDeadline.pause/resume` is reference-counted, so
// a `toolGate` hook that fires *inside* `executeToolBatch`'s already-paused
// region composes cleanly (the inner resume never un-pauses the outer region).
//
// Module layout (execution-guidance rule 4): the deadline is a run-owned host
// concern here; `packages/agent` stays Electron-free and only exposes the
// pause/resume primitive on the deadline object.

/**
 * The slice of `AgentRunDeadline` this registry needs. A structural type (not
 * an import of the class) keeps the coupling minimal — any pausable clock works,
 * which is what the contract test injects.
 */
export interface PausableRunDeadline {
  pause(): void
  resume(): void
}

/**
 * Deadlines for runs currently in flight, keyed by thread id. The run registers
 * on start and clears on end (agent-service), so at most one deadline exists per
 * thread — the current run's. A fire site whose session has no registered
 * deadline (e.g. `beforeSubmitPrompt` on the compose path, before the run's
 * deadline is created) pauses nothing, which is correct: there is no idle clock
 * to pause yet.
 */
const deadlines = new Map<string, PausableRunDeadline>()

/**
 * Register the active run's idle deadline for its thread (H4). Called at run
 * start in agent-service alongside `registerHaltTarget`; cleared in the run's
 * `finally` via {@link clearRunDeadline}.
 */
export function registerRunDeadline(threadId: string, deadline: PausableRunDeadline): void {
  deadlines.set(threadId, deadline)
}

/**
 * Clear the registered deadline for a thread, but only when it is still the same
 * object — so a stale clear from a finished run cannot unregister a newer run
 * that already reclaimed the thread (mirrors `clearHaltTarget`).
 */
export function clearRunDeadline(threadId: string, deadline: PausableRunDeadline): void {
  if (deadlines.get(threadId) === deadline) deadlines.delete(threadId)
}

/**
 * Run `fn` with the session's idle deadline paused for its entire duration
 * (decision 13). Used by every blocking hook fire site to wrap the hook wait so
 * a slow blocking hook does not advance the idle clock. `sessionId` is the
 * run's thread id (`agentSession.conversationId`); when it is undefined or no
 * deadline is registered for it, this is a transparent pass-through — the hook
 * still runs, just with no clock to pause. The deadline is always resumed, even
 * when `fn` throws.
 */
export async function withRunDeadlinePaused<T>(
  sessionId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = sessionId !== undefined ? deadlines.get(sessionId) : undefined
  if (!deadline) return fn()
  deadline.pause()
  try {
    return await fn()
  } finally {
    deadline.resume()
  }
}

/** Test-only: drop all registered deadlines between cases. */
export function resetRunDeadlinesForTest(): void {
  deadlines.clear()
}
