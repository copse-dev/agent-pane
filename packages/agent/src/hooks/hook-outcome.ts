// Canonical hook decision vocabulary — Milestone 0.1 of the hooks platform.
//
// The registry normalizes every hook's output to these types; the harness
// consumes only this vocabulary and (later) dialect adapters translate each
// on-disk format to/from it. The "Canonical decision vocabulary" section of
// docs/plans/hooks-and-feature-packs.md is the source of truth: any semantic
// change here must edit that document in the same PR (execution-guidance rule 1).
//
// Decisions 4 and 11 require blocking and async hooks to have *separate* outcome
// types, so that an async hook — which by design runs off the critical path and
// can only report back through the pending-message queue — cannot influence the
// current action. Splitting the type makes `decision`, `updatedInput`, and
// `injectContext` on an async hook a compile error instead of a runtime bug
// (execution-guidance rule 3, "make illegal states unrepresentable"). Async is
// otherwise unused in M0.1 (no async canonical events are wired yet), but the
// split exists from day one.

/** A permission-style verdict on the action a blocking hook is gating. */
export type HookDecision = 'allow' | 'deny' | 'ask'

/** A programmatic stop (`continue: false`); outranks every other field. */
export interface HookHaltRun {
  reason: string
}

/** A message pushed onto the pending-message queue — the async output channel. */
export interface HookQueueMessage {
  text: string
  /** Byte-for-byte the user's send-now semantics (decision 4). */
  sendNow: boolean
}

/**
 * Output of a *blocking* hook: one that runs in the harness's critical path and
 * may influence the current action. Every field is optional — a hook with no
 * opinion returns nothing (or `void`), which the registry treats as a no-op.
 */
export interface BlockingHookOutcome {
  /** Permission verdict (tool gates). Absent means "no opinion". */
  decision?: HookDecision
  /** Stop the whole run. Outranks everything (decision 12). */
  haltRun?: HookHaltRun
  /** Rewrite the gated tool's input; re-runs policy analysis (tool gates; H1). */
  updatedInput?: Record<string, unknown>
  /** Text injected into the current turn's context (blocking-only, decision 11). */
  injectContext?: string
  /** Message fed to the model when the decision is deny/ask. */
  agentMessage?: string
  /** Message shown to the user as a hook card. */
  userMessage?: string
}

/**
 * Output of an *async* (detached) hook. It has already left the critical path,
 * so by construction (decisions 4 & 11) it cannot carry `decision`,
 * `updatedInput`, or `injectContext`: its only channels are the pending-message
 * queue, a programmatic stop, a user-facing card, and session-env propagation.
 */
export interface AsyncHookOutcome {
  /** Stop the whole run (allowed from async hooks, decision 12). */
  haltRun?: HookHaltRun
  /** The only async output channel (decision 4): a pending queued message. */
  queueMessage?: HookQueueMessage
  /** Message shown to the user as a hook card. */
  userMessage?: string
  /** Env vars propagated to later hook processes (`sessionStart`; H4). */
  sessionEnv?: Record<string, string>
}
