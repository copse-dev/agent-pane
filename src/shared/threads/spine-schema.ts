import type {
  ModelUsage,
  QueuedMessageOrigin,
  SubagentSession,
  Thread,
  ThreadReview,
  TranscriptAttachment,
} from '@shared/types'
import { planArtifactRefs } from './plan-schema.ts'

/**
 * On-disk format for the filesystem-native thread store (issue #644).
 *
 * A thread is a directory whose linear history is an append-only JSONL "spine"
 * (`events.jsonl`), one {@link SpineMessageLine} per finalized message, plus
 * non-message observability lines (`hook_run`, Plan Mode `plan`). Prose
 * (message text, reasoning) lives in referenced OKF markdown files; large or
 * opaque content (tool results, images, plan revisions) lives in referenced
 * files. This module is pure — no `node:fs`/Electron — so the fidelity
 * round-trip is unit-testable without shims. See {@link foldThread} /
 * {@link explodeMessage}.
 */

/** Bump when the spine line shape changes in a backwards-incompatible way. */
export const SPINE_SCHEMA_VERSION = 1

/** Synchronous content hash (hex). Injected so the pure modules stay Node-free. */
export type HashFn = (input: string) => string

/** Thread metadata persisted in `meta.json` — everything except the messages. */
export type ThreadMeta = Omit<Thread, 'messages'>

/** A reference to a file within the thread directory plus a hash of its logical content. */
export interface ContentRef {
  /** Path relative to the thread directory, e.g. `messages/<id>.md`. */
  ref: string
  /** Hex hash of the *logical* content (the message body / result string), not the file bytes. */
  sha256: string
}

/** A referenced image blob (a data URL stored verbatim in a blob file). */
export interface ImageRef {
  ref: string
  sha256: string
}

/** A tool call as persisted on a spine line. `running` is never written. */
export interface SpineToolCall {
  id: string
  name: string
  args: unknown
  status: 'done' | 'error'
  /** null when the tool produced no result; a ref (possibly to empty contents) otherwise. */
  result: ContentRef | null
  editStats?: { additions: number; deletions: number }
  /** ACP tool-call kind (`'execute'`, `'read'`, …) from an external ACP agent. */
  kind?: string
  /** Render `result` as Markdown (external ACP agents author Markdown output). */
  resultFormat?: 'markdown'
  subagent?: SpineSubagentRef
}

/** A nested subagent session; its messages live in `<ref>events.jsonl` + files. */
export interface SpineSubagentRef {
  /** Directory ref, e.g. `subagents/<id>/`. */
  ref: string
  kind: SubagentSession['kind']
  status: SubagentSession['status']
  prompt: string
  summary: string | null
  usage?: ModelUsage
  model?: string
  localFallback?: boolean
}

/** One line of `events.jsonl`: a single finalized message. */
export interface SpineMessageLine {
  v: number
  type: 'message'
  id: string
  role: 'user' | 'assistant' | 'error'
  /** Always set for top-level messages; may be absent on legacy subagent messages. */
  createdAt?: number
  /** The message content OKF file. Always present (body may be empty). */
  content: ContentRef
  reasoning?: ContentRef
  images?: ImageRef[]
  commandSummary?: string
  /** Small-model polish for the turn tool rollup; optional, display-only. */
  toolSummary?: string
  /** Display-only transcript attachment chips (user messages); short, inlined here. */
  attachments?: TranscriptAttachment[]
  /**
   * Primary-chat model for this assistant message (picker id). Optional for
   * legacy spines written before per-message provenance existed.
   */
  model?: string
  /** Post-turn review verdict anchored to this message (kept inline — small). */
  review?: ThreadReview
  /**
   * Hook provenance when this turn was started by a hook follow-up (decision
   * 10). Persisted so the transcript can mark a hook-originated turn after a
   * reload; `editedByUser` records that a human edited the hook's text before it
   * dispatched (authorship stays honest). Absent = human-authored.
   */
  origin?: QueuedMessageOrigin
  editedByUser?: boolean
  toolCalls: SpineToolCall[]
}

/**
 * Compact normalized summary of what a hook execution decided. Small on
 * purpose: the raw response bytes live in the referenced stdout blob, so text
 * channels are summarized as character counts, never inlined.
 */
export interface SpineHookRunDecision {
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
 * One line of `events.jsonl`: a single hook execution (decision 6 of
 * docs/plans/hooks-and-feature-packs.md). Always-on observability: every hook
 * run — in-process function hooks and spawned command hooks — appends one of
 * these, with raw stdout/stderr captured as blobs for command hooks. Old
 * readers ({@link parseSpine}) skip any non-`message` line, so this type is
 * forward-compatible by construction.
 */
export interface SpineHookRunLine {
  v: number
  type: 'hook_run'
  /** Unique id of this execution; also names the stdout/stderr blobs. */
  id: string
  /** Event name that fired (canonical or dialect, e.g. `beforeShellExecution`). */
  event: string
  /** Stable hook id: the registry id (function hooks) or command string (command hooks). */
  hookId: string
  executor: 'function' | 'command'
  /** Emitting attribution: the agent run (turn) this execution belongs to, when known. */
  turnId?: string
  /** LLM-call index within the run at emission time (0 = before the first call). */
  step?: number
  startedAt: number
  /** Wall-clock duration of the execution. */
  durationMs: number
  /**
   * Process exit code. Command hooks only: `null` when the process was killed
   * (timeout / output cap) or failed to spawn; absent for function hooks.
   */
  exitCode?: number | null
  /**
   * Whether the raw stdout was successfully converted into a hook response.
   * Empty stdout is an intentional no-response (`true`); non-empty non-JSON
   * output (e.g. a stray debug print) is `false` — visible right next to the
   * bytes in the stdout blob. Function hooks return typed outcomes in-process,
   * so they are always `true`.
   */
  parseOk: boolean
  /** Normalized decision summary (parsed form; raw bytes in the stdout blob). */
  decision: SpineHookRunDecision
  /** Error message when a function hook threw (fail-hard: the run still surfaced it). */
  error?: string
  /** Raw stream captures (command hooks; absent for function hooks). */
  stdout?: ContentRef
  stderr?: ContentRef
  /** Content-addressed toolset fingerprint hash (see {@link toolsetBlobRef}). */
  toolset?: string
}

/** Plan Mode lifecycle actions recorded on the spine (issue #1080, P1). */
export const PLAN_SPINE_ACTIONS = ['create', 'revise', 'comment', 'approve', 'abandon'] as const
export type PlanSpineAction = (typeof PLAN_SPINE_ACTIONS)[number]

/**
 * One line of `events.jsonl`: a Plan Mode lifecycle event. Artifacts live under
 * `plans/<planId>/`; this line is the append-only commit point (same pattern as
 * `hook_run`). Old readers ({@link parseSpine}) skip non-`message` lines.
 */
export interface SpinePlanLine {
  v: number
  type: 'plan'
  /** Lifecycle action for this append. */
  action: PlanSpineAction
  /** Unique id of this spine event (not the plan id). */
  id: string
  planId: string
  /** Revision touched by create/revise/comment/approve when applicable. */
  revision?: number
  createdAt: number
  /** Revision markdown ref, e.g. `plans/<planId>/revision-2.md`. */
  artifact?: ContentRef
  /** Set when `action` is `comment`. */
  commentId?: string
  /** Set when `action` is `approve`. */
  executionProfileId?: string
  /** Content hash of the approved revision body when `action` is `approve`. */
  contentHash?: string
}

/** Durable host-owned shell authorization record (issue #1249 / #656). */
export interface SpinePermissionDecisionLine {
  v: number
  type: 'permission_decision'
  id: string
  turnId?: string
  step?: number
  decidedAt: number
  originalCommand: string
  /** Present when a blocking hook rewrote the command before host policy ran. */
  effectiveCommand?: string
  originalMode: 'guarded-yolo'
  effectiveMode: 'guarded-yolo'
  sandboxState: 'project-sandbox' | 'unsandboxed'
  harmDecision: 'allow' | 'prompt' | 'deny'
  policyDecision: 'allow' | 'prompt' | 'deny'
  reasons: string[]
  userResponse: 'approved' | 'declined' | 'not-required'
}

/** Discriminated union of every line type this schema version can write. */
export type SpineLine =
  SpineMessageLine | SpineHookRunLine | SpinePlanLine | SpinePermissionDecisionLine

/** Thread-relative ref of the content-addressed toolset fingerprint blob. */
export function toolsetBlobRef(hash: string): string {
  return `blobs/toolset-${hash}.json`
}

/** Blob refs a hook_run line points at (kept alive across full rewrites). */
export function hookRunBlobRefs(line: SpineHookRunLine): string[] {
  const refs: string[] = []
  if (line.stdout) refs.push(line.stdout.ref)
  if (line.stderr) refs.push(line.stderr.ref)
  if (line.toolset) refs.push(toolsetBlobRef(line.toolset))
  return refs
}

export function serializeSpineLine(line: SpineLine): string {
  return JSON.stringify(line)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isContentRef(value: unknown): value is ContentRef {
  return isRecord(value) && typeof value['ref'] === 'string' && typeof value['sha256'] === 'string'
}

function isSpineMessageLine(value: unknown): value is SpineMessageLine {
  if (!isRecord(value)) return false
  const role = value['role']
  return (
    value['type'] === 'message' &&
    typeof value['v'] === 'number' &&
    typeof value['id'] === 'string' &&
    (role === 'user' || role === 'assistant' || role === 'error') &&
    isContentRef(value['content']) &&
    (value['toolCalls'] === undefined || Array.isArray(value['toolCalls']))
  )
}

function isSpineHookRunLine(value: unknown): value is SpineHookRunLine {
  if (!isRecord(value)) return false
  const executor = value['executor']
  return (
    value['type'] === 'hook_run' &&
    typeof value['v'] === 'number' &&
    typeof value['id'] === 'string' &&
    typeof value['event'] === 'string' &&
    typeof value['hookId'] === 'string' &&
    (executor === 'function' || executor === 'command') &&
    typeof value['startedAt'] === 'number' &&
    typeof value['durationMs'] === 'number' &&
    typeof value['parseOk'] === 'boolean' &&
    isRecord(value['decision'])
  )
}

function isSpinePermissionDecisionLine(value: unknown): value is SpinePermissionDecisionLine {
  if (!isRecord(value)) return false
  const harm = value['harmDecision']
  const policy = value['policyDecision']
  const response = value['userResponse']
  return (
    value['type'] === 'permission_decision' &&
    typeof value['v'] === 'number' &&
    typeof value['id'] === 'string' &&
    typeof value['decidedAt'] === 'number' &&
    typeof value['originalCommand'] === 'string' &&
    value['originalMode'] === 'guarded-yolo' &&
    value['effectiveMode'] === 'guarded-yolo' &&
    (value['sandboxState'] === 'project-sandbox' || value['sandboxState'] === 'unsandboxed') &&
    (harm === 'allow' || harm === 'prompt' || harm === 'deny') &&
    (policy === 'allow' || policy === 'prompt' || policy === 'deny') &&
    Array.isArray(value['reasons']) &&
    value['reasons'].every((reason) => typeof reason === 'string') &&
    (response === 'approved' || response === 'declined' || response === 'not-required')
  )
}

/** Parse one spine line into the {@link SpineLine} union. Null on malformed/unknown. */
export function parseSpineLine(raw: string): SpineLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string') return null
  const type = parsed['type']
  if (type === 'message' && isSpineMessageLine(parsed)) {
    // Tolerate an absent toolCalls array (forward/backward compatibility).
    if (!Array.isArray(parsed.toolCalls)) parsed.toolCalls = []
    return parsed
  }
  if (type === 'plan') {
    const action = (parsed as { action?: unknown }).action
    if (typeof action !== 'string' || !(PLAN_SPINE_ACTIONS as readonly string[]).includes(action)) {
      return null
    }
    return parsed as unknown as SpinePlanLine
  }

  if (type === 'hook_run' && isSpineHookRunLine(parsed)) return parsed
  if (type === 'permission_decision' && isSpinePermissionDecisionLine(parsed)) return parsed

  return null
}

/** Serialize a full `events.jsonl` body (trailing newline included). */
export function serializeSpine(lines: SpineLine[]): string {
  return lines.map(serializeSpineLine).join('\n') + (lines.length > 0 ? '\n' : '')
}

/**
 * Parse a full `events.jsonl` body into *message* lines only, skipping blank,
 * malformed, and non-`message` lines. This is the reader every fold/display
 * path uses, which is exactly what keeps old readers forward-tolerant of new
 * line types (decision 6): a hook_run line is invisible to them.
 */
export function parseSpine(raw: string): SpineMessageLine[] {
  const out: SpineMessageLine[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseSpineLine(line)
    if (parsed?.type === 'message') out.push(parsed)
  }
  return out
}

/**
 * One physical `events.jsonl` line kept verbatim alongside its parsed form
 * (null when the line is not a known {@link SpineLine}). Writers that rewrite
 * the file use this so lines they don't understand — future line types, not
 * just hook_run — survive byte-for-byte instead of being silently dropped.
 */
export interface SpineEntry {
  /** The verbatim line (no trailing newline). */
  raw: string
  line: SpineLine | null
}

/** Parse a full `events.jsonl` body into entries, preserving unknown lines. */
export function parseSpineEntries(raw: string): SpineEntry[] {
  const out: SpineEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    out.push({ raw: line, line: parseSpineLine(line) })
  }
  return out
}

/** Serialize entries back to an `events.jsonl` body (trailing newline included). */
export function serializeSpineEntries(entries: SpineEntry[]): string {
  return entries.map((e) => e.raw).join('\n') + (entries.length > 0 ? '\n' : '')
}

/**
 * Rebuild an `events.jsonl` body from a freshly exploded message spine while
 * preserving every non-message line already in the file (hook_run records and
 * any future line type). This is the full-save round-trip decision 6 requires:
 * `writeThread` regenerates the spine from `thread.messages` alone, so without
 * this merge an independently appended hook_run line would vanish on the next
 * save.
 *
 * Read-merge-write was chosen over carrying non-message lines in memory: the
 * in-memory `Thread` travels through IPC to the renderer, and widening that
 * surface for write-only observability records would leak main-process
 * persistence details everywhere. Merging at the one place that rewrites the
 * file keeps hook_run lines a pure main-process concern.
 *
 * Ordering: each preserved line stays anchored to the message line that
 * preceded it in the old file (hook runs are appended mid-turn, before their
 * turn's messages finalize). Lines whose anchor message was deleted are kept
 * at the end rather than dropped.
 *
 * `preservedRefs` lists blob refs the preserved lines reference, so the
 * caller's stale-file pruning keeps them alive. Unknown future line types are
 * preserved verbatim but cannot declare refs; a future type that references
 * blobs must extend this collection.
 */
export function rebuildSpinePreservingNonMessageLines(
  existingRaw: string,
  messages: SpineMessageLine[],
): { body: string; preservedRefs: string[] } {
  interface Preserved {
    raw: string
    anchor: string | null
  }
  const preserved: Preserved[] = []
  const preservedRefs: string[] = []
  let lastMessageId: string | null = null
  for (const entry of parseSpineEntries(existingRaw)) {
    if (entry.line?.type === 'message') {
      lastMessageId = entry.line.id
      continue
    }
    preserved.push({ raw: entry.raw, anchor: lastMessageId })
    if (entry.line?.type === 'hook_run') preservedRefs.push(...hookRunBlobRefs(entry.line))
    if (entry.line?.type === 'plan') preservedRefs.push(...planArtifactRefs(entry.line.artifact))
  }
  if (preserved.length === 0) {
    return { body: serializeSpine(messages), preservedRefs }
  }

  const byAnchor = new Map<string | null, string[]>()
  for (const p of preserved) {
    const list = byAnchor.get(p.anchor)
    if (list) list.push(p.raw)
    else byAnchor.set(p.anchor, [p.raw])
  }

  const out: string[] = [...(byAnchor.get(null) ?? [])]
  byAnchor.delete(null)
  for (const message of messages) {
    out.push(serializeSpineLine(message))
    const anchored = byAnchor.get(message.id)
    if (anchored) {
      out.push(...anchored)
      byAnchor.delete(message.id)
    }
  }
  // Anchors deleted from the message set: keep their lines at the end.
  for (const rest of byAnchor.values()) out.push(...rest)

  return { body: out.join('\n') + '\n', preservedRefs }
}
