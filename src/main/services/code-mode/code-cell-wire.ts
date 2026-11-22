/**
 * Messages on a code-cell container's private stdio link.
 *
 * The link is the frame multiplexer the container runtime already uses
 * (`../container-runtime/egress-link.ts`): only the guest opens streams, and
 * the host answers each by its target name. A code-cell guest opens two kinds:
 *
 * - one **control** stream at start-up, which stays open for the container's
 *   life. The guest's first line on it says it is ready; the host then writes
 *   one `run` message per cell and the guest answers each with its outcome.
 * - one **tool** stream per `await tools.<name>(args)` in a cell. The guest
 *   writes one request and ends its side; the host answers with one response.
 *
 * Every message is one line of JSON. Both ends treat the other as hostile:
 * every line is size-capped and decoded through a schema, and anything that
 * does not decode closes the stream.
 *
 * Dependency-light on purpose: this module is bundled into the guest runner.
 */
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

export const CODE_CELL_CONTROL_TARGET = 'cells.code.copse.internal:1'
export const CODE_CELL_TOOL_TARGET = 'tools.code.copse.internal:1'

/** The largest line either end accepts on a control or tool stream. */
export const CODE_CELL_MESSAGE_LIMIT = 8 * 1024 * 1024
/** The longest cell the host sends, in UTF-16 code units. */
export const CODE_CELL_SOURCE_LIMIT = 200_000
/** The most text a guest returns for one cell (value and logs together), in bytes. */
export const CODE_CELL_OUTPUT_LIMIT = 1024 * 1024
/** The longest a cell may run, end to end. */
export const CODE_CELL_MAX_TIMEOUT_MS = 5 * 60_000

const cellId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const cellRunSchema = z
  .object({
    op: z.literal('run'),
    id: cellId,
    code: z.string().max(CODE_CELL_SOURCE_LIMIT),
    timeoutMs: z.number().int().positive().max(CODE_CELL_MAX_TIMEOUT_MS),
  })
  .strict()
export type CellRun = z.infer<typeof cellRunSchema>

export const guestReadySchema = z
  .object({ ready: z.literal(true), node: z.string().max(64) })
  .strict()

export const cellResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      id: cellId,
      ok: z.literal(true),
      value: z.string(),
      logs: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: cellId,
      ok: z.literal(false),
      error: z.string(),
      logs: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
])
export type CellResult = z.infer<typeof cellResultSchema>

export const guestControlMessageSchema = z.union([guestReadySchema, cellResultSchema])
export type GuestControlMessage = z.infer<typeof guestControlMessageSchema>

/** Tool names a cell may ask for: what first-party tools are called, nothing else. */
export const CELL_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export const toolCallRequestSchema = z
  .object({
    cell: cellId,
    name: z.string().regex(CELL_TOOL_NAME),
    args: z.record(z.string(), z.unknown()),
  })
  .strict()
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>

export const toolCallResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.string() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
])
export type ToolCallResponse = z.infer<typeof toolCallResponseSchema>

/** One message as the line both ends write. */
export function encodeLine(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(line) > CODE_CELL_MESSAGE_LIMIT) {
    throw new Error('code-cell message exceeds the message limit')
  }
  return line
}

/** Decode one line, or null when it is not JSON or not the schema's shape. */
export function decodeLine<T>(
  line: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | null {
  return safeJsonParse(line, decodeWithSchema(schema))
}

/**
 * Split a stream into lines as they arrive, refusing any line longer than
 * `limit` bytes. Resolves when the stream ends; rejects (and destroys the
 * stream) on an oversized line or a stream error.
 */
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  limit = CODE_CELL_MESSAGE_LIMIT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending: Buffer[] = []
    let pendingBytes = 0
    const fail = (error: Error): void => {
      stream.off('data', onData)
      stream.destroy(error)
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      let rest = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      for (;;) {
        const newline = rest.indexOf(0x0a)
        if (newline === -1) {
          pendingBytes += rest.length
          if (pendingBytes > limit) {
            fail(new Error('code-cell line exceeds the message limit'))
            return
          }
          if (rest.length > 0) pending.push(rest)
          return
        }
        const piece = rest.subarray(0, newline)
        if (pendingBytes + piece.length > limit) {
          fail(new Error('code-cell line exceeds the message limit'))
          return
        }
        const line = Buffer.concat([...pending, piece]).toString('utf8')
        pending = []
        pendingBytes = 0
        rest = rest.subarray(newline + 1)
        onLine(line)
      }
    }
    stream.on('data', onData)
    stream.once('end', () => {
      resolve()
    })
    stream.once('error', (error: Error) => {
      reject(error)
    })
    stream.once('close', () => {
      resolve()
    })
  })
}

/** Read a whole stream as one message of at most `limit` bytes. */
export async function readMessage(
  stream: Readable,
  limit = CODE_CELL_MESSAGE_LIMIT,
): Promise<string> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const part of stream) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    bytes += buffer.length
    if (bytes > limit) {
      stream.destroy()
      throw new Error('code-cell message exceeds the message limit')
    }
    parts.push(buffer)
  }
  return Buffer.concat(parts).toString('utf8')
}
