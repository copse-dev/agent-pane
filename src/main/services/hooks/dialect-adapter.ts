// Dialect adapters — A2 of the hooks platform (decision 8).
//
// A *dialect* is an on-disk hook config format, identified by **source path**,
// translated by its **adapter**: `.cursor/hooks.json` → cursor,
// `.claude/settings.json` → claude, `.copse/hooks.json` → copse (F1). Each
// adapter owns discovery, parsing, matchers, wire marshalling in *both*
// directions, its per-event exit-code table, and unsupported-capability
// reporting. Foreign files stay strictly on their vendor's contract; unknown
// events are warned about, never silently skipped.
//
// The registry (`packages/agent`) is dialect-agnostic: it stores `CommandHook`
// objects and dispatches them through the host-injected `CommandHookRunner`.
// The runner (see `command-hook-runner.ts`) is the one place that looks a hook's
// dialect up here and delegates marshalling + interpretation to the right
// adapter — so a dialect is fully described by its {@link DialectAdapter}.
import type { CommandHook, HookDialect } from '@copse/agent/hooks/command-executor.ts'
import type { AgentSessionInfo, HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome, HookQueueMessage } from '@copse/agent/hooks/hook-outcome.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import type { HookSpawnResult } from './hook-spawn.ts'

/** Where hook discovery looks, and whether project-scoped configs may be honoured. */
export interface DialectDiscoverOpts {
  /** Trusted project root used for repo-supplied hook discovery. */
  workspaceRoot: string | null
  /** Thread checkout root used for matchers, payload cwd, and process execution. */
  executionRoot?: string | null
  /** Whether the workspace is trusted (gates project-supplied hook configs). */
  projectTrusted: boolean
}

/**
 * A dialect's interpretation of one spawned hook process, *before* the runner
 * applies the hook's `onFailure` (decision 9). The exit-code table lives in the
 * adapter: it decides whether the run `failed` (crash / timeout / invalid JSON)
 * and, on success, the normalized {@link BlockingHookOutcome}. The runner then
 * turns a failure into `deny` (failClosed) or a no-op (fail-open) uniformly.
 */
export interface DialectInterpretation {
  /** Normalized outcome on a clean run; null when the hook abstained. */
  outcome: BlockingHookOutcome | null
  /**
   * An async follow-up message (D1: `subagentStop`'s `followup_message`), routed
   * through the pending-message queue (decision 4). Only detached async events
   * set it; the runner passes it through to {@link CommandHookResult.queueMessage}.
   */
  queueMessage?: HookQueueMessage
  /**
   * Session-scoped environment variables a `sessionStart` hook returned (H4;
   * Cursor's `env` output field). Fire-and-forget: the runner passes it through
   * to {@link CommandHookResult.sessionEnv}, and the fire site collects it into
   * the session env store so it propagates to *later* hook process spawns for
   * the session (decision-doc "`sessionStart` env propagation"). Only the
   * `sessionStart` interpretation sets it.
   */
  sessionEnv?: Record<string, string>
  /** True when the process crashed, timed out, or emitted invalid JSON. */
  failed: boolean
  /** Whether stdout parsed cleanly (empty stdout counts as an intentional no-response). */
  parseOk: boolean
  /** The dialect wire event name for the spine record (e.g. `beforeShellExecution`). */
  spineEvent: string
  /** Compact decision summary for the spine `hook_run` line. */
  spineDecision: SpineHookRunDecision
  /** First-failure message for the Sources per-hook error indicator, when `failed`. */
  runtimeError?: string
}

/**
 * The seam every dialect implements. The runner calls these; nothing else needs
 * to know a hook's dialect. Discovery/list live on the concrete adapter modules
 * (they return dialect-shaped summaries for Sources); this interface is the
 * per-execution contract the runner depends on.
 */
export interface DialectAdapter {
  dialect: HookDialect
  /**
   * Marshal a canonical `toolGate` payload into this dialect's stdin wire shape
   * (decision 8: "a Claude hook sees Claude's stdin shape and tool names").
   * Returns null when the hook does not apply to this tool — matching is done at
   * discovery, but the marshaller is the final guard against firing a hook for a
   * tool its declared event/matcher never covered. `session` carries the real
   * conversation / generation ids + running model to stamp on the payload (B4).
   */
  marshalToolGateRequest(
    hook: CommandHook,
    payload: HookEventPayloads['toolGate'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's per-event exit-code table to a spawn result. Pure w.r.t.
   * the process (no I/O); the runner owns spawning, spine recording, and the
   * `onFailure` resolution that this interpretation feeds.
   */
  interpretToolGate(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['toolGate'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `beforeSubmitPrompt` payload into this dialect's stdin
   * wire shape (B1). Optional: a dialect with no compose-path hook equivalent
   * (Claude has none) omits it and the runner abstains for that dialect. Returns
   * null when the hook does not apply.
   */
  marshalBeforeSubmitPromptRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['beforeSubmitPrompt'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `beforeSubmitPrompt` exit-code / response table to a
   * spawn result (B1). Optional, paired with {@link marshalBeforeSubmitPromptRequest}.
   * `continue: false` normalizes to a `haltRun` outcome; `user_message` /
   * `agentMessage` ride along for surfacing.
   */
  interpretBeforeSubmitPrompt?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['beforeSubmitPrompt'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `afterFileEdit` payload into this dialect's stdin wire
   * shape (B2). Optional: a dialect with no post-edit hook equivalent omits it
   * and the runner abstains for that dialect. Cursor's afterFileEdit is a
   * notification (it cannot block or return data), so its paired
   * {@link interpretAfterFileEdit} never yields a control-flow decision.
   */
  marshalAfterFileEditRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['afterFileEdit'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `afterFileEdit` exit-code table to a spawn result (B2).
   * Optional, paired with {@link marshalAfterFileEditRequest}. For a
   * notification-only dialect (Cursor) the outcome is always null; a crash /
   * timeout / non-zero exit is reported as `failed` for the spine + Sources
   * error indicator, but the edit has already landed so nothing is blocked.
   */
  interpretAfterFileEdit?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['afterFileEdit'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `stop` payload into this dialect's stdin wire shape
   * (B3). Optional: a dialect with no run-end hook equivalent omits it and the
   * runner abstains for that dialect. Cursor's `stop` is a notification (it
   * carries only `status` and returns nothing), so its paired
   * {@link interpretStop} never yields a control-flow decision.
   */
  marshalStopRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['stop'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `stop` exit-code table to a spawn result (B3).
   * Optional, paired with {@link marshalStopRequest}. `stop` is detached
   * (decision 3, never awaited) and notification-only for Cursor, so the outcome
   * is always null; a crash / timeout / non-zero exit is reported as `failed`
   * for the spine + Sources error indicator only. Follow-ups (`followup_message`
   * on dialects that declare one) route through the pending-message queue (C2),
   * never a bespoke stop protocol (decision 4).
   */
  interpretStop?(spawn: HookSpawnResult, payload: HookEventPayloads['stop']): DialectInterpretation
  /**
   * Marshal a canonical `subagentStart` payload into this dialect's stdin wire
   * shape (D1). Optional: a dialect with no subagent-lifecycle hook omits it and
   * the runner abstains. Cursor's `subagentStart` is a **blocking** decision
   * (allow / deny; `ask` is treated as deny) with the subagent type + resolved
   * `subagent_model` on stdin, so a matcher-on-type hook can deny a spawn.
   */
  marshalSubagentStartRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['subagentStart'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `subagentStart` response table (D1). Optional, paired
   * with {@link marshalSubagentStartRequest}. `permission: deny` (and `ask`,
   * which Cursor treats as deny) normalizes to a `deny` decision that prevents
   * the spawn; `user_message` rides along for surfacing.
   */
  interpretSubagentStart?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['subagentStart'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `subagentStop` payload into this dialect's stdin wire
   * shape (D1). Optional. Cursor's `subagentStop` is detached (decision 3) and
   * may return a `followup_message` (consumed only on `status: completed`) that
   * routes through the pending-message queue (C2/C3), never a bespoke protocol.
   */
  marshalSubagentStopRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['subagentStop'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `subagentStop` response table (D1). Optional, paired
   * with {@link marshalSubagentStopRequest}. A `followup_message` (on
   * `completed`) becomes a {@link DialectInterpretation.queueMessage} the runner
   * forwards to the queue channel; otherwise the outcome is null (notification).
   */
  interpretSubagentStop?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['subagentStop'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `afterToolUse` payload into this dialect's stdin wire
   * shape (D2). Optional. Cursor splits it into `afterShellExecution` (shell:
   * `command` + capped `output` + `duration`) and `afterMCPExecution` (MCP:
   * `tool_name` + `tool_input` + capped `result_json` + `duration`) by the tool
   * name — payload flavors of the one canonical event. Returns null when the
   * hook does not apply to this tool (the final guard past discovery matching).
   */
  marshalAfterToolUseRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['afterToolUse'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `afterToolUse` response table (D2). Optional, paired
   * with {@link marshalAfterToolUseRequest}. Cursor's after-events are
   * fire-and-forget (detached, decision 3): they return nothing, so the outcome
   * is always null; a crash / timeout / non-zero exit is reported as `failed`
   * for the spine + Sources error indicator only — there is nothing to block
   * post-hoc (the tool already ran).
   */
  interpretAfterToolUse?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['afterToolUse'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `sessionStart` payload into this dialect's stdin wire
   * shape (H4). Optional: a dialect with no session-start hook omits it and the
   * runner abstains for that dialect. Cursor's `sessionStart` carries
   * `session_id` / `is_background_agent` / `composer_mode`; Claude's carries
   * `source` and the **optional `model`** (B4 readiness — the only Claude
   * agent-session event with a model field). `session` supplies the ids + model.
   */
  marshalSessionStartRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['sessionStart'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `sessionStart` response table (H4). Optional, paired
   * with {@link marshalSessionStartRequest}. `sessionStart` is fire-and-forget
   * (decision 3), so it never yields a control-flow `outcome`; its actionable
   * output is {@link DialectInterpretation.sessionEnv} (Cursor's `env` object),
   * which the fire site propagates to later hook spawns. A crash / timeout /
   * non-zero exit is reported `failed` for the spine + Sources only — there is
   * nothing to block (the session has already started).
   */
  interpretSessionStart?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['sessionStart'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `beforeDiffApply` payload into this dialect's stdin wire
   * shape (F2, Copse-native). Optional: only the Copse dialect declares it
   * (Cursor / Claude have no diff-queue hook), so foreign adapters omit it and
   * the runner abstains. Blocking decision — a `deny` / `haltRun` blocks the
   * queued (or direct) diff apply.
   */
  marshalBeforeDiffApplyRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['beforeDiffApply'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `beforeDiffApply` response table (F2). Optional, paired
   * with {@link marshalBeforeDiffApplyRequest}. `deny` (and `ask`, treated as
   * deny) / `haltRun` normalizes to a blocking outcome the fire site turns into
   * a blocked apply.
   */
  interpretBeforeDiffApply?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['beforeDiffApply'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `afterDiffApply` payload into this dialect's stdin wire
   * shape (F2, Copse-native). Optional (Copse-only). Async observation: the diff
   * already landed / was rejected, so it never gates control flow.
   */
  marshalAfterDiffApplyRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['afterDiffApply'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `afterDiffApply` response table (F2). Optional, paired
   * with {@link marshalAfterDiffApplyRequest}. Observation-only: the outcome is
   * always null; a `followup_message` routes through the queue as a
   * {@link DialectInterpretation.queueMessage} (decision 4).
   */
  interpretAfterDiffApply?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['afterDiffApply'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `permissionDecision` payload into this dialect's stdin
   * wire shape (F2, Copse-native). Optional (Copse-only). Async observation
   * fired after the permission verdict — a clean seam an audit logger (#840) can
   * consume; it can never change the verdict.
   */
  marshalPermissionDecisionRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['permissionDecision'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `permissionDecision` response table (F2). Optional,
   * paired with {@link marshalPermissionDecisionRequest}. Observation-only: the
   * outcome is always null; a `followup_message` routes through the queue.
   */
  interpretPermissionDecision?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['permissionDecision'],
  ): DialectInterpretation
  /**
   * Marshal a canonical `postTurnReview` payload into this dialect's stdin wire
   * shape (F2, Copse-native). Optional (Copse-only). Async observation fired
   * after a post-turn review verdict.
   */
  marshalPostTurnReviewRequest?(
    hook: CommandHook,
    payload: HookEventPayloads['postTurnReview'],
    session?: AgentSessionInfo,
  ): unknown
  /**
   * Apply this dialect's `postTurnReview` response table (F2). Optional, paired
   * with {@link marshalPostTurnReviewRequest}. Observation-only: the outcome is
   * always null; a `followup_message` routes through the queue.
   */
  interpretPostTurnReview?(
    spawn: HookSpawnResult,
    payload: HookEventPayloads['postTurnReview'],
  ): DialectInterpretation
  /**
   * Record the first runtime failure of a hook this session (deduped per
   * dialect-event + command), feeding the Sources per-hook error indicator. The
   * runner passes the interpretation's resolved `spineEvent` so the key matches
   * discovery/list exactly. Never affects the decision (fail-open / failClosed).
   */
  recordRuntimeFailure(event: string, command: string, message: string): void
}
