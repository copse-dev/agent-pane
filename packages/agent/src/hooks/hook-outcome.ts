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

/**
 * Compact normalized summary of what a hook execution decided. Small on
 * purpose: the raw response bytes live in the referenced stdout blob, so text
 * channels are summarized as character counts, never inlined.
 */
export interface HookRunDecision {
  /** Permission verdict the hook returned, when it returned one. */
  permission?: 'allow' | 'deny' | 'ask'
  /** The hook asked to halt the whole run (`continue: false`). */
  haltRun?: boolean
  /**
   * A `haltRun` was routed through the run's abort path (H3, decision 12): the
   * active turn tree was aborted, attributed to this hook. Set on the halt
   * *effect* line the abort path records — distinct from `haltRun`, which only
   * marks that a hook *asked* to halt.
   */
  haltApplied?: boolean
  /**
   * A `haltRun` was a **suppressed no-op** because it arrived stale — its
   * emitting turn tree was no longer current (H3, decision 16). Recorded so a
   * late async hook's suppressed stop is visible in the transcript rather than
   * silent, and never mistaken for an applied halt.
   */
  haltSuppressedStale?: boolean
  /**
   * The halt reason the hook supplied (`continue: false` + `stopReason`), bounded
   * for the spine. Carried on the halt effect line so a future hook card (G1) can
   * render *why* the run stopped without re-reading the stdout blob.
   */
  stopReason?: string
  /** The hook rewrote the gated tool's input. */
  updatedInput?: boolean
  /**
   * This nudge was the one the loop actually pushed into the conversation. Set
   * on the nudge *effect* line the loop records — distinct from a step-boundary
   * hook's own execution line, which only marks that the hook *offered* an
   * `injectContext`.
   *
   * Several nudge hooks routinely fire at the same step boundary and all return
   * text, but `runAgentLoop` pushes at most one of them (`reasoning-runaway`
   * supersedes `truncation-continue` on a cut-off reasoning stream, for
   * instance). Without this line every offer reads as an applied effect, so a
   * discarded nudge is indistinguishable from the one that steered the model.
   */
  nudgeApplied?: boolean
  /**
   * How the applied nudge reached the model: appended to a normal tool-enabled
   * turn, or used as the prompt for a forced text-only finalization. Carried on
   * the nudge effect line.
   */
  nudgeMechanism?: 'tool-enabled-message' | 'text-only-turn'
  /** Character counts of text channels (full text: stdout blob / applied context). */
  injectContextChars?: number
  agentMessageChars?: number
  userMessageChars?: number
  /**
   * Character count of an async queued follow-up the hook emitted (D1:
   * `subagentStop`'s `followup_message`, routed to the pending-message queue).
   */
  queuedMessageChars?: number
  /**
   * Number of session-scoped env keys a `sessionStart` hook exported (H4;
   * Cursor's `env` output). Recorded so an env-propagating session start is
   * visible in the transcript — the values themselves stay in the stdout blob.
   */
  sessionEnvKeys?: number
  /**
   * The hook ran inside the project sandbox and was **blocked by it** (F3,
   * decision 7): the OS seatbelt logged policy violations (or the sandbox
   * wrapper failed to start), so the run is resolved as a failure per the hook's
   * `onFailure` — never a silent fail-open that hides the block. Keyed off
   * runner-side signals only (recorded violations / wrapper spawn failure), never
   * the hook's own stdout (issue #104), so a hook cannot forge or hide it.
   */
  sandboxBlocked?: boolean
}

/**
 * Provenance of a queued message (decision 10). A queued message can be authored
 * by a human (origin absent) or produced by an async hook's `queueMessage`
 * output — the only async output channel (decision 4). The message role stays
 * `user` for the LLM; `origin` lives purely in the data model so the UI can
 * attribute it and the spine stays honest about authorship.
 */
export interface QueuedMessageOrigin {
  kind: 'hook'
  /** Registered hook id that produced the message. */
  hookId: string
  /** Canonical event the hook fired on (e.g. `stop`, `afterToolUse`). */
  event: string
}
