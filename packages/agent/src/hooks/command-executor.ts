// The command executor kind — A1 of the hooks platform.
//
// Decision 1: "two executor kinds (function / command)". First-party hooks are
// in-process functions (fail-hard, decision 9); user/project hooks are spawned
// commands whose failure semantics are *per-dialect* (decision 9 again: Cursor
// fails open by default but honours `failClosed`, Claude denies on exit 2, the
// Copse dialect uses `onFailure: open|closed`).
//
// This module defines only the *contract* a command hook and its runner satisfy.
// The concrete spawn — process, sandbox, stdin/stdout marshalling, per-event
// exit-code tables — lives in `src/main/services/hooks/` (execution-guidance
// rule 4); `packages/agent` stays Electron-free. A2's dialect adapters populate
// the fields left abstract here (matchers, wire marshalling, the exit-code table).
import type { BlockingHookOutcome, HookQueueMessage } from './hook-outcome.ts'
import type { HookContext, HookEventName, HookEventPayloads } from './canonical-events.ts'

/**
 * On-disk hook config format, identified by source path (decision 8):
 * `.cursor/hooks.json` → cursor, `.claude/settings.json` → claude,
 * `.copse/hooks.json` → copse.
 */
export type HookDialect = 'cursor' | 'claude' | 'copse'

/**
 * How a command hook resolves a failure (crash / timeout / invalid JSON) —
 * decision 9. `open` allows the gated action through (Cursor's default); `closed`
 * blocks it (Cursor `failClosed: true`, Claude exit-2 deny, Copse
 * `onFailure: closed`). The registry never *chooses* this: the dialect adapter
 * sets it per hook and the runner applies it, so command failures never
 * fail-hard the way function-hook throws do.
 */
export type CommandHookFailureMode = 'open' | 'closed'

/**
 * A registered command (spawned-process) hook. Its `id` in dialect configs is
 * typically the command string itself. A2's adapters attach matchers and the
 * dialect wire marshalling; A1 pins the shape the registry stores and dispatches.
 */
export interface CommandHook<E extends HookEventName = HookEventName> {
  /** Stable id for spine attribution, the Sources UI, and dedup. */
  id: string
  /** Canonical event this hook subscribes to. */
  event: E
  /** Discriminant: always `'command'` (vs first-party function hooks). */
  executor: 'command'
  /** Which dialect this hook was discovered from (drives failure semantics). */
  dialect: HookDialect
  /** The command line to spawn (resolved by the dialect adapter). */
  command: string
  /**
   * Per-dialect failure resolution (decision 9). Set by the adapter from the
   * dialect's rules (`failClosed`, exit-code tables, `onFailure`). The registry
   * applies it verbatim — it is never fail-hard.
   */
  onFailure: CommandHookFailureMode
  /**
   * Working directory the process spawns in. Dialect-agnostic spawn attribute
   * (every dialect resolves relative commands against the directory of the
   * config that declared it). Set by the adapter at discovery; the host runner
   * spawns in it. Absent = the runner's default (workspace root / cwd).
   */
  cwd?: string
  /**
   * Trusted thread checkout root captured at discovery. Unlike `cwd`, this is
   * the workspace identity placed on vendor wire payloads even for user hooks
   * whose process cwd is their user config directory.
   */
  executionRoot?: string
  /**
   * Per-hook timeout in milliseconds (decision 13; vendor defaults live in the
   * adapter). A dialect-agnostic spawn attribute the host runner enforces.
   * Absent = the runner's default.
   */
  timeoutMs?: number
  /**
   * Whether the hook runs inside the project sandbox (decision 7). Hooks are
   * **sandboxed by default** (`true`); the Copse dialect's per-hook
   * `sandbox: false` is the escape. **F1 only parses / carries this field** —
   * the sandbox-by-default spawn reversal + enforcement is F3, and the OS sandbox
   * is macOS-only (a default, not a guarantee). Absent on dialects that do not
   * express it (Cursor / Claude), which today spawn outside the sandbox until F3.
   */
  sandbox?: boolean
  /**
   * Whether the hook opted into **detached async** dispatch (decision 2). Only
   * meaningful for canonical events whose default is blocking but that allow an
   * async opt-in (`asyncOptIn`, e.g. `afterFileEdit`); the fire site partitions
   * hooks by this flag, dispatching `async` ones through the detached executor
   * (C1). Set by the Copse dialect's `async: true`; absent (blocking) otherwise.
   */
  async?: boolean
  /**
   * Per-script auto-continuation `loop_limit` (decision 5), tighten-only. Bounds
   * *this hook's* machine-turn contributions to `min(loop_limit, global
   * remaining)`; `null` (unlimited) is clamped to the global budget with a
   * warning — human-in-the-loop is the floor (`clampLoopLimit`). **F1 parses /
   * carries this field**; the drain-time budget enforcement lives on the C3
   * ledger surface. Absent on dialects that do not express it.
   */
  loopLimit?: number | null
}

/**
 * The outcome of running one command hook, as the runner reports it back to the
 * registry. Command hooks — being spawned processes — surface only the *blocking*
 * outcome vocabulary here (async command dispatch and the queue channel are
 * Phase C); a hook that emitted no usable response has `outcome: null`.
 */
export interface CommandHookResult {
  /** Normalized blocking outcome, or null when the hook abstained / had no response. */
  outcome: BlockingHookOutcome | null
  /** True when the process crashed, timed out, or emitted invalid JSON. */
  failed: boolean
  /** How the dialect resolved a failure (decision 9); undefined unless `failed`. */
  failureMode?: CommandHookFailureMode
  /**
   * An async command hook's queued follow-up (D1: `subagentStop`'s
   * `followup_message`, Cursor's `stop`-style loop). The **only** async output
   * channel is the pending-message queue (decision 4), so a detached command
   * hook that wants to auto-continue reports the message here; `emitAsync`
   * forwards it to `onAsyncOutcome` for the C2 queue channel (never a bespoke
   * protocol). Absent on blocking-event runs and notification-only completions.
   */
  queueMessage?: HookQueueMessage
  /**
   * Session-scoped environment variables a `sessionStart` command hook returned
   * (H4). The async fire site (`emitAsync`) forwards this to `onAsyncOutcome` as
   * the outcome's {@link AsyncHookOutcome.sessionEnv}, so the host collects it
   * into the session env store for propagation to later hook spawns. Absent on
   * every non-`sessionStart` run.
   */
  sessionEnv?: Record<string, string>
}

/**
 * Host-injected runner for command hooks. Given a registered command hook and
 * its event payload, the runner spawns the process, marshals the dialect's wire
 * shape in both directions (A2), captures stdout/stderr for the spine (decision
 * 6), and **resolves failures per the hook's dialect (decision 9) before
 * returning** — the registry never fail-hards a command hook.
 *
 * Defined in `packages/agent` (Electron-free); the concrete implementation lives
 * in `src/main/services/hooks/`. A1 ships the interface plus a host stub; A2
 * fills in real dialect adapters. The runner is handed only the *base*
 * {@link HookContext} — never `FunctionHookContext` — so a command hook can
 * never emit typed chunks or read loop state (decision 15).
 */
export interface CommandHookRunner {
  run<E extends HookEventName>(
    hook: CommandHook<E>,
    payload: HookEventPayloads[E],
    context: HookContext,
  ): Promise<CommandHookResult>
}
