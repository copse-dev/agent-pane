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
import type { BlockingHookOutcome } from './hook-outcome.ts'
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
   * Per-hook timeout in milliseconds (decision 13; vendor defaults live in the
   * adapter). A dialect-agnostic spawn attribute the host runner enforces.
   * Absent = the runner's default.
   */
  timeoutMs?: number
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
