import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, isAbsolute, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExternalSessionSource } from '@shared/types'
import { safeJsonParse } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'

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
      const value = safeJsonParse(line)
      if (!isRecord(value)) continue
      if (visit(value) === false) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
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
