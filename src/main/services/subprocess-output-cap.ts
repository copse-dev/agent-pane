import { stripAnsiSequences } from '@shared/text/strip-ansi.ts'

/** Max bytes retained from subprocess stdout/stderr (matches run_shell tool). */
export const COMMAND_OUTPUT_MAX_BYTES = 100 * 1024

export const COMMAND_OUTPUT_TRUNCATED_MARKER = '\n[output truncated]\n'

/** Default timeout for internal git/rg/gh subprocesses (pager-safe). */
export const COMMAND_RUNNER_DEFAULT_TIMEOUT_MS = 30_000

/** Long-running indexer / probe commands opt into this explicitly. */
export const COMMAND_RUNNER_LONG_TIMEOUT_MS = 3_600_000

/** Strip ANSI/VT control sequences; anchor on ESC so literal `[..m` text is preserved. */
export function stripTerminalControlSequences(text: string): string {
  return stripAnsiSequences(text)
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8')
}

function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return buf.subarray(buf.length - maxBytes).toString('utf8')
}

export function truncateCommandOutput(text: string, maxBytes = COMMAND_OUTPUT_MAX_BYTES): string {
  const total = utf8ByteLength(text)
  if (total <= maxBytes) return text

  const markerBytes = utf8ByteLength(COMMAND_OUTPUT_TRUNCATED_MARKER)
  const budget = Math.max(0, maxBytes - markerBytes)
  const headBytes = Math.floor(budget / 2)
  const tailBytes = budget - headBytes
  return utf8Head(text, headBytes) + COMMAND_OUTPUT_TRUNCATED_MARKER + utf8Tail(text, tailBytes)
}

function headTailBudget(maxBytes: number): { headMax: number; tailMax: number } {
  const markerBytes = utf8ByteLength(COMMAND_OUTPUT_TRUNCATED_MARKER)
  const budget = Math.max(0, maxBytes - markerBytes)
  const headMax = Math.floor(budget / 2)
  return { headMax, tailMax: budget - headMax }
}

/**
 * Memory-bounded subprocess output (head + tail). Streamed deltas match what
 * {@link toString} will contain, aside from a one-time truncation marker.
 */
export class CappedOutputAccumulator {
  private head = ''
  private tail = ''
  private middleDropped = false
  private readonly headMax: number
  private readonly tailMax: number

  constructor(maxBytes = COMMAND_OUTPUT_MAX_BYTES) {
    const { headMax, tailMax } = headTailBudget(maxBytes)
    this.headMax = headMax
    this.tailMax = tailMax
  }

  /** Append a chunk; returns text that should be streamed to the UI. */
  append(chunk: string): string {
    if (!chunk) return ''

    let rest = chunk
    let emit = ''

    if (utf8ByteLength(this.head) < this.headMax) {
      const room = this.headMax - utf8ByteLength(this.head)
      const take = utf8Head(rest, room)
      if (take) {
        this.head += take
        emit += take
        rest = rest.slice(take.length)
      }
    }

    if (!rest) return emit

    if (!this.middleDropped) {
      this.middleDropped = true
      emit += COMMAND_OUTPUT_TRUNCATED_MARKER
    }

    const prevTail = this.tail
    this.tail = utf8Tail(this.tail + rest, this.tailMax)
    if (this.tail.length > prevTail.length) {
      emit += this.tail.slice(prevTail.length)
    }
    return emit
  }

  toString(): string {
    if (!this.middleDropped) return this.head + this.tail
    return this.head + COMMAND_OUTPUT_TRUNCATED_MARKER + this.tail
  }
}

/** Append to a string field without exceeding max UTF-8 bytes (head/tail truncation). */
export function appendFlatCapped(target: string, chunk: string, maxBytes: number): string {
  const combined = target + chunk
  if (utf8ByteLength(combined) <= maxBytes) return combined
  return truncateCommandOutput(combined, maxBytes)
}
