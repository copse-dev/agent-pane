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
// running while observation hooks from earlier steps run. This module therefore
// carries no control-flow return the caller must consume — it resolves to a
// count purely so a test can await completion and assert the event fired. B3
// implements the minimal fire-and-forget dispatch this needs; C1 generalizes it
// (concurrency cap + FIFO + turn-tree epoch attribution) without changing this
// seam. See docs/plans/hooks-and-feature-packs.md (B3 row, decision 3).
//
// **Follow-ups via C2, not a bespoke protocol (decision 4).** Cursor's `stop` is
// notification-only (it carries `status` and returns nothing), so nothing here
// parses a follow-up into an action. Should a dialect return a `followup_message`,
// it must route through the pending-message queue (C2) — B3 invents no stop
// follow-up path. C2 owns queue origin attribution + the held state; until it
// lands, stop follow-ups are honestly deferred (plan-doc note, B3 row).
//
// Cursor declares a `stop` hook (wired here); Claude's `Stop` hook is a Phase-D
// concern (subagentStop et al.) and not wired by B3, so no Claude hooks
// participate — matching the vendor audit.
import { HookRegistry } from '@copse/agent/hooks/hook-registry.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { DialectDiscoverOpts } from './dialect-adapter.ts'
import { cursorStopHooks } from './cursor-adapter.ts'
import { createCommandHookRunner } from './command-hook-runner.ts'

/** What the turn-end / abort fire site learns from the stop hooks. */
export interface StopResult {
  /**
   * How many `stop` hooks matched and were dispatched. `stop` is
   * notification-only and detached, so there is no decision to surface — the
   * count is enough for the fire site to know work was dispatched and for tests
   * to assert the event fired.
   */
  ran: number
}

/**
 * Discover + fire every dialect's `stop` command hooks with the terminal
 * `status`. Returns `{ ran: 0 }` when nothing matches. Firing goes through the
 * canonical `stop` registry event, so this is exactly the seam later phases
 * extend — the adapters are the only dialect-aware code.
 *
 * The returned promise is **not** meant to gate turn completion: the caller
 * dispatches this detached (`void runStopHooks(...)`) per decision 3 (no drain
 * barrier). Awaiting it is a test affordance, not a harness invariant — a slow
 * `stop` hook must never delay the turn's `done`.
 */
export async function runStopHooks(
  status: HookEventPayloads['stop']['status'],
  opts: DialectDiscoverOpts & { signal?: AbortSignal; agentSession?: AgentSessionInfo },
): Promise<StopResult> {
  const payload: HookEventPayloads['stop'] = { status }

  const discoverOpts: DialectDiscoverOpts = {
    workspaceRoot: opts.workspaceRoot,
    projectTrusted: opts.projectTrusted,
  }
  // Cursor is the only dialect with a run-end hook wired in B3; Claude's Stop is
  // Phase D. A late abort must not block discovery, so we do not gate on the
  // signal here — the runner still bails per-hook if it fires.
  const hooks = await cursorStopHooks(payload, discoverOpts)
  if (hooks.length === 0) return { ran: 0 }

  const registry = new HookRegistry()
  for (const hook of hooks) registry.registerCommand(hook)

  // Fire the command hooks. `stop` is notification-only (Cursor), so we ignore
  // the outcomes — there is no decision to act on and, being detached, no caller
  // is waiting on one. We intentionally do NOT forward the abort signal into the
  // context: decision 3 says a `stop` hook already dispatched runs to its own
  // completion even after abort; halting it would be a drain barrier by another
  // name.
  await registry.emit('stop', payload, {
    runCommandHook: createCommandHookRunner(),
    // The fire site captured the session by value before dispatching detached,
    // so a slow stop hook still marshals the finished turn's identity (B4 +
    // decision 3) even after the run's recording context is torn down.
    ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
  })

  return { ran: hooks.length }
}
