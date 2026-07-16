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
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import type { BlockingHookOutcome } from '@copse/agent/hooks/hook-outcome.ts'
import type { SpineHookRunDecision } from '@shared/threads/spine-schema.ts'
import type { HookSpawnResult } from './hook-spawn.ts'

/** Where hook discovery looks, and whether project-scoped configs may be honoured. */
export interface DialectDiscoverOpts {
  /** Absolute workspace root, or null when no workspace is open. */
  workspaceRoot: string | null
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
   * tool its declared event/matcher never covered.
   */
  marshalToolGateRequest(hook: CommandHook, payload: HookEventPayloads['toolGate']): unknown
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
   * Record the first runtime failure of a hook this session (deduped per
   * dialect-event + command), feeding the Sources per-hook error indicator. The
   * runner passes the interpretation's resolved `spineEvent` so the key matches
   * discovery/list exactly. Never affects the decision (fail-open / failClosed).
   */
  recordRuntimeFailure(event: string, command: string, message: string): void
}
