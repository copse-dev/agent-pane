/**
 * Shared hook summary for Settings → Sources and `hooks:list` IPC.
 *
 * Cursor hooks (`hooks.json`) and Claude Code hooks (`.claude/settings.json`)
 * both surface here; execution stays in their respective runners.
 */

/** Where a hook definition came from — determines its trust tier. */
export type HookScope = 'user' | 'project'

/** Which product's on-disk schema produced this hook. */
export type HookFamily = 'cursor' | 'claude' | 'copse'

/** A single discovered hook command for diagnostics / Settings → Sources. */
export interface HookSummary {
  family: HookFamily
  /** Lifecycle event name (Cursor or Claude), e.g. `beforeShellExecution` / `PreToolUse`. */
  event: string
  /** The shell command Copse will spawn for this hook. */
  command: string
  /** Absolute path to the config file that declared it. */
  source: string
  scope: HookScope
  /**
   * Claude matcher group filter (tool-name pattern). Omitted for Cursor hooks and
   * for Claude groups with no matcher / `"*"`.
   */
  matcher?: string
  /**
   * Whether Copse actually acts on this event. Declared-but-unwired events (e.g.
   * Cursor `stop`) surface as `false` so Sources can badge them "unsupported"
   * rather than looking active. Absent means "supported" (back-compat).
   */
  supported?: boolean
  /**
   * First runtime failure observed this session (crash / timeout / invalid JSON,
   * **or a blocked-by-sandbox run** — F3, decision 7), surfaced as a per-hook
   * error indicator. Never affects fail-open semantics.
   */
  lastError?: string
  /**
   * Whether this hook opted **out** of the project sandbox (Copse `sandbox: false`,
   * decision 7 / F3). Present and `false` only for the escape — Sources badges it
   * "outside sandbox" so the risk is visible; omitted means sandboxed-by-default
   * (the norm, and all Cursor / Claude hooks, which cannot express the escape).
   */
  sandbox?: boolean
}

/** A malformed / unrecognised `hooks.json` entry, surfaced as a warning row. */
export interface HookValidationWarning {
  /** Event name the bad entry was under, when known. */
  event?: string
  /** Human-readable problem (e.g. "unknown event", "missing command"). */
  message: string
  /** Absolute path to the config file that declared it. */
  source: string
  scope: HookScope
}

/** `hooks:list` payload: the discovered hooks plus any authoring-time warnings. */
export interface HooksListResult {
  hooks: HookSummary[]
  warnings: HookValidationWarning[]
}

/**
 * `hooks:test` request — identify a single discovered hook (as surfaced in
 * Settings → Sources) to run once against a **synthetic** payload (G2 dry-run
 * tester). Carries exactly the {@link HookSummary} fields that reconstruct the
 * hook's spawn (`family` → dialect, `event` → the wire event to synthesize a
 * payload for, `command`, `source` → the config dir the command resolves
 * against) plus the `sandbox` escape so the dry run honours F3's
 * sandboxed-by-default behavior. A dry run never mutates live agent state,
 * starts a turn, records the spine, or grants a real permission — the returned
 * {@link BlockingHookOutcome} is *displayed*, never applied.
 */
export interface HookTestRequest {
  family: HookFamily
  /** Dialect wire event name (exactly as shown in Sources / {@link HookSummary.event}). */
  event: string
  /** The shell command to spawn — the hook's id. */
  command: string
  /** Absolute path to the config file that declared it (its dir is the cwd). */
  source: string
  scope: HookScope
  /**
   * Whether the hook opted out of the project sandbox (Copse `sandbox: false`).
   * Mirrors {@link HookSummary.sandbox}; absent means sandboxed-by-default.
   */
  sandbox?: boolean
}

/**
 * `hooks:test` result — everything one dry run observed. The four raw streams
 * the tester surfaces (stdin / stdout / stderr / exit / duration) plus the
 * derived summary (`parseOk`, a one-line `outcomeSummary`). When the hook's
 * event cannot be synthesized (unsupported / no dialect marshaller), `ran` is
 * false and `error` explains why — no process was spawned.
 */
export interface HookTestResult {
  /** True when a synthetic payload was built and the hook was actually spawned. */
  ran: boolean
  /** Why the dry run could not run (unsupported event / missing marshaller); set when `!ran`. */
  error?: string
  /** Canonical event the synthetic payload targeted (e.g. `toolGate`). */
  canonicalEvent?: string
  /** The dialect wire event the payload marshalled to (a `toolGate` flavor may differ). */
  wireEvent?: string
  /** The exact JSON string written to the hook's stdin. */
  stdin?: string
  /** Raw stdout captured from the hook (the response channel). */
  stdout?: string
  /** Raw stderr captured from the hook. */
  stderr?: string
  /** Process exit code; null when the hook was killed (timeout) or failed to start. */
  exitCode?: number | null
  /** Wall-clock duration of the spawned process in milliseconds. */
  durationMs?: number
  /** True when the hook was killed for exceeding the dry-run timeout. */
  timedOut?: boolean
  /** True when the process failed to start. */
  spawnError?: boolean
  /** Whether the hook actually ran inside the project sandbox (macOS-only; a default, not a guarantee). */
  sandboxed?: boolean
  /** Whether the dialect parsed the hook's stdout cleanly. */
  parseOk?: boolean
  /** One-line human-readable summary of the normalized outcome (e.g. `allow`, `deny — <msg>`, `no opinion`). */
  outcomeSummary?: string
}

/**
 * `hooks:runDetail` result — the raw record behind one hook card, fetched on
 * demand when the user opens a card's inspector. The transcript holds only the
 * compact card (decision 10); the bodies live in the thread's blobs, so this is
 * read straight back off the spine rather than kept in renderer state. Every
 * field is optional because a run only has the streams its executor produced:
 * command hooks have stdin/stdout/stderr, function hooks a payload + outcome.
 */
export interface HookRunDetail {
  /** False when no `hook_run` with this id is recorded (yet) in the thread. */
  found: boolean
  /** Canonical or dialect event name that fired. */
  event?: string
  hookId?: string
  executor?: 'function' | 'command'
  /** Agent run (turn) the execution was attributed to. */
  turnId?: string
  /** LLM-call index within the run at emission time (0 = before the first call). */
  step?: number
  /** Epoch millis the execution started. */
  startedAt?: number
  durationMs?: number
  /** Process exit code (command hooks); null when the process was killed. */
  exitCode?: number | null
  parseOk?: boolean
  /** Content-addressed fingerprint of the toolset offered to the model at the time. */
  toolset?: string
  /** What the hook was handed: exact stdin JSON (command) / dispatch payload (function). */
  payload?: string
  /** Raw captured stdout — the response channel (command hooks). */
  stdout?: string
  /** Raw captured stderr (command hooks). */
  stderr?: string
  /** JSON of the full text of every channel a function hook applied. */
  outcome?: string
  /**
   * Refs the record pointed at that are no longer on disk (pruned blobs, or a
   * run recorded before a capture existed). Named so the inspector can say the
   * body is gone instead of implying the hook produced nothing.
   */
  missing?: string[]
}

/**
 * Main → renderer bridge payload for an async hook's `queueMessage` output — the
 * only async output channel (decision 4). The host translates an async outcome
 * into this and sends it over `agent:hook_queue_message`; the renderer lands it
 * in the thread's pending-message queue with origin attribution (decision 10)
 * and epoch (decision 16). `sendNow` carries byte-for-byte the user's send-now
 * semantics for a **current** epoch; a stale send-now is downgraded to held on
 * the renderer side (decision 16) — the staleness check owns the abort back-door.
 */
export interface HookQueueMessagePayload {
  /** Thread whose queue the message lands in. */
  threadId: string
  /** The hook-authored message text. */
  text: string
  /** Whether the hook requested immediate send (decision 4). */
  sendNow: boolean
  /** Provenance: the hook + event that produced it (decision 10). */
  origin: import('./thread.ts').QueuedMessageOrigin
  /** Emitting turn-tree epoch (decision 16); checked for staleness on arrival. */
  epoch: string
}
