import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, isAbsolute, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExternalSessionSource } from '@shared/types'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

/**
 * One line of a CLI's session file: any JSON object. The fields each reader
 * uses are checked where it reads them, since both CLIs add and rename fields
 * between releases and a line Copse cannot fully read is still worth the parts
 * it can.
 */
const jsonlRecordSchema = z.record(z.string(), z.unknown())
const decodeJsonlRecord = decodeWithSchema(jsonlRecordSchema)

/**
 * Read a JSONL file one record at a time, skipping lines that are not JSON
 * objects (a session file being written can end in a partial line). Stops after
 * `maxBytes`, or as soon as `visit` returns `false`.
 */
export async function readJsonlRecords(
  path: string,
  visit: (record: Record<string, unknown>) => boolean | undefined,
  options: { maxBytes?: number } = {},
): Promise<void> {
  const stream = createReadStream(path, {
    encoding: 'utf8',
    ...(options.maxBytes === undefined ? {} : { end: options.maxBytes - 1 }),
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const value = safeJsonParse(line, decodeJsonlRecord)
      if (value === null) continue
      if (visit(value) === false) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

/**
 * The JSON-object records in the last `bytes` of a file, oldest first. The
 * first, probably partial, line of the window is dropped unless the window
 * starts at the beginning of the file.
 */
export async function readJsonlTail(
  path: string,
  bytes: number,
): Promise<Record<string, unknown>[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.flatMap((line) => {
      if (!line.trim()) return []
      const value = safeJsonParse(line, decodeJsonlRecord)
      return value === null ? [] : [value]
    })
  } finally {
    await handle.close()
  }
}

/**
 * Wrappers a tool or harness puts around text it sends as a user message: the
 * user never typed it, so it is not a prompt to show or a title to use.
 */
const HARNESS_TAGS = [
  'system-reminder',
  'task-notification',
  'ci-monitor-event',
  'user-prompt-submit-hook',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
]
const HARNESS_BLOCK = new RegExp(`<(${HARNESS_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g')

/** `text` without harness blocks, trimmed; `''` when nothing the user typed is left. */
export function withoutHarnessText(text: string): string {
  return text.replace(HARNESS_BLOCK, '').trim()
}

/** True when the whole of `text` is one XML-style element, such as `<wake …>…</wake>`. */
function isWholeElement(text: string): boolean {
  const trimmed = text.trim()
  const tag = /^<([a-z][\w-]*)(?:\s[^>]*)?>/i.exec(trimmed)?.[1]
  return tag !== undefined && trimmed.endsWith(`</${tag}>`)
}

/**
 * A list-row title for a prompt: its text without harness blocks, and without
 * the tags when the whole prompt is one element (a harness that wraps what the
 * user typed). `null` when nothing readable is left.
 */
export function titleFromPrompt(text: string): string | null {
  const cleaned = withoutHarnessText(text)
  if (!isWholeElement(cleaned)) return cleaned || null
  // A wrapper's inner text is escaped markup; read it as the user wrote it.
  const inner = decodeEntities(cleaned.replace(/<[^>]*>/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .trim()
  return inner || null
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const point = Number(name.slice(1))
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

/** Opaque, stable name for one tool's session, safe to hand to the renderer. */
export function externalSessionKey(source: ExternalSessionSource, sessionId: string): string {
  return createHash('sha256').update(`${source}\0${sessionId}`).digest('hex').slice(0, 32)
}

/**
 * `cwd` relative to `root`, or `null` when it is outside it. `''` is the root
 * itself. Sessions from other folders are never offered for this project.
 */
export function cwdWithinRoot(cwd: string, root: string): string | null {
  if (!isAbsolute(cwd)) return null
  const rel = relative(root, cwd)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

/** Milliseconds for an ISO timestamp, or `null`. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** One line, at most `max` characters, for a list row or thread title. */
export function oneLineTitle(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Tool output larger than this is cut, so one noisy command cannot bloat a thread. */
export const MAX_IMPORTED_TOOL_RESULT_CHARS = 64 * 1024

export function capToolResult(text: string): string {
  if (text.length <= MAX_IMPORTED_TOOL_RESULT_CHARS) return text
  const dropped = text.length - MAX_IMPORTED_TOOL_RESULT_CHARS
  return `${text.slice(0, MAX_IMPORTED_TOOL_RESULT_CHARS)}\n\n[${String(dropped)} more characters were not imported]`
}

/**
 * How a prompt Copse itself sent through a coding agent begins (the session
 * notes or the bridge identity, built in `buildAcpPrompt`). Such sessions are
 * already Copse threads, so they are not offered for import.
 */
const COPSE_PROMPT_OPENINGS = [
  'Session notes: this session persists across turns',
  'Copse native bridge for this turn:',
  'You are continuing an existing Copse chat.',
]

export function isCopsePrompt(text: string): boolean {
  const trimmed = text.trimStart()
  return COPSE_PROMPT_OPENINGS.some((opening) => trimmed.startsWith(opening))
}
