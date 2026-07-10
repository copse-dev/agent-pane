import type { ModelUsage, SubagentSession, Thread, TranscriptAttachment } from '@shared/types'

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
  toolCalls: SpineToolCall[]
}

export function serializeSpineLine(line: SpineMessageLine): string {
  return JSON.stringify(line)
}

/** Parse one spine line. Returns null on malformed JSON or a non-message line. */
export function parseSpineLine(raw: string): SpineMessageLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== 'message' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    return null
  }
  const line = parsed as SpineMessageLine
  // Tolerate an absent toolCalls array (forward/backward compatibility).
  if (!Array.isArray(line.toolCalls)) line.toolCalls = []
  return line
}

/** Serialize a full `events.jsonl` body (trailing newline included). */
export function serializeSpine(lines: SpineMessageLine[]): string {
  return lines.map(serializeSpineLine).join('\n') + (lines.length > 0 ? '\n' : '')
}

/** Parse a full `events.jsonl` body, skipping blank or malformed lines. */
export function parseSpine(raw: string): SpineMessageLine[] {
  const out: SpineMessageLine[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseSpineLine(line)
    if (parsed) out.push(parsed)
  }
  return out
}
