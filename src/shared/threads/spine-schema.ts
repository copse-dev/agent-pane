import type {
  ModelUsage,
  SubagentSession,
  Thread,
  ThreadReview,
  TranscriptAttachment,
} from '@shared/types'

/**
 * On-disk format for the filesystem-native thread store (issue #644).
 *
 * A thread is a directory whose linear history is an append-only JSONL "spine"
 * (`events.jsonl`), one {@link SpineMessageLine} per finalized message. Prose
 * (message text, reasoning) lives in referenced OKF markdown files; large or
 * opaque content (tool results, images) lives in referenced blobs. This module
 * is pure — no `node:fs`/Electron — so the fidelity round-trip is unit-testable
 * without shims. See {@link foldThread} / {@link explodeMessage}.
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
  /** Display-only transcript attachment chips (user messages); short, inlined here. */
  attachments?: TranscriptAttachment[]
  /**
   * Primary-chat model for this assistant message (picker id). Optional for
   * legacy spines written before per-message provenance existed.
   */
  model?: string
  /** Post-turn review verdict anchored to this message (kept inline — small). */
  review?: ThreadReview
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
  /** The hook rewrote the gated tool's input. */
  updatedInput?: boolean
  /** Character counts of text channels (full text: stdout blob / applied context). */
  injectContextChars?: number
  agentMessageChars?: number
  userMessageChars?: number
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

/** Discriminated union of every line type this schema version can write. */
export type SpineLine = SpineMessageLine | SpineHookRunLine

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

/** Parse one spine line into the {@link SpineLine} union. Null on malformed/unknown. */
export function parseSpineLine(raw: string): SpineLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    return null
  }
  const type = (parsed as { type?: unknown }).type
  if (type === 'message') {
    const line = parsed as SpineMessageLine
    // Tolerate an absent toolCalls array (forward/backward compatibility).
    if (!Array.isArray(line.toolCalls)) line.toolCalls = []
    return line
  }
  if (type === 'hook_run') {
    return parsed as SpineHookRunLine
  }
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
