/** Max bytes retained from subprocess stdout/stderr (matches run_shell tool). */
export const COMMAND_OUTPUT_MAX_BYTES = 100 * 1024

export const COMMAND_OUTPUT_TRUNCATED_MARKER = '\n[output truncated]\n'

/** Default timeout for internal git/rg/gh subprocesses (pager-safe). */
export const COMMAND_RUNNER_DEFAULT_TIMEOUT_MS = 30_000

/**
 * Workspace file-path listing (`rg --files` / `find`). Local trees finish quickly;
 * SSH + ProxyCommand hosts often need minutes on a large tree.
 */
export const FILE_INDEX_LIST_TIMEOUT_MS = 5 * 60 * 1000

/** Path lists for large repos exceed the default 100 KiB command cap. */
export const FILE_INDEX_LIST_MAX_BYTES = 8 * 1024 * 1024

/** Long-running indexer / probe commands opt into this explicitly. */
export const COMMAND_RUNNER_LONG_TIMEOUT_MS = 3_600_000

/** Strip ANSI/VT control sequences; anchor on ESC so literal `[..m` text is preserved. */
export function stripTerminalControlSequences(text: string): string {
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Longest prefix within `maxBytes` of UTF-8, never splitting a code point into U+FFFD. */
function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  return text.slice(0, utf8PrefixFit(text, maxBytes).units)
}

/** Longest suffix within `maxBytes` of UTF-8, never splitting a code point into U+FFFD. */
function utf8Tail(text: string, maxBytes: number): string {
  let start = text.length
  let bytes = 0
  while (start > 0) {
    let i = start - 1
    const c = text.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const prev = text.charCodeAt(i - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) i -= 1
    }
    const cp = codePointUtf8(text, i)
    if (bytes + cp.bytes > maxBytes) break
    bytes += cp.bytes
    start = i
  }
  return text.slice(start)
}

export function truncateCommandOutput(text: string, maxBytes = COMMAND_OUTPUT_MAX_BYTES): string {
  const total = utf8ByteLength(text)
  if (total <= maxBytes) return text

  const markerBytes = utf8ByteLength(COMMAND_OUTPUT_TRUNCATED_MARKER)
  // A cap too small for the marker keeps a bare head so the result still fits.
  if (maxBytes < markerBytes) return utf8Head(text, maxBytes)
  const budget = maxBytes - markerBytes
  const headBytes = Math.floor(budget / 2)
  const tailBytes = budget - headBytes
  return utf8Head(text, headBytes) + COMMAND_OUTPUT_TRUNCATED_MARKER + utf8Tail(text, tailBytes)
}

/** UTF-8 byte length of the code point starting at `text[i]`, and how many UTF-16 units it spans. */
function codePointUtf8(text: string, i: number): { bytes: number; units: number } {
  const c = text.charCodeAt(i)
  if (c < 0x80) return { bytes: 1, units: 1 }
  if (c < 0x800) return { bytes: 2, units: 1 }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const next = text.charCodeAt(i + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 }
  }
  // BMP characters and lone surrogates (encoded as U+FFFD) are three bytes.
  return { bytes: 3, units: 1 }
}

/**
 * Longest prefix of `text` that fits in `maxBytes` of UTF-8 without splitting a
 * code point. Returns the prefix's UTF-16 length and its byte length.
 */
function utf8PrefixFit(text: string, maxBytes: number): { units: number; bytes: number } {
  let i = 0
  let bytes = 0
  while (i < text.length) {
    const cp = codePointUtf8(text, i)
    if (bytes + cp.bytes > maxBytes) break
    bytes += cp.bytes
    i += cp.units
  }
  return { units: i, bytes }
}

/**
 * Shortest prefix of `text` whose UTF-8 encoding is at least `minBytes`, ending on
 * a code point boundary. Returns its UTF-16 length and byte length.
 */
function utf8PrefixCovering(text: string, minBytes: number): { units: number; bytes: number } {
  let i = 0
  let bytes = 0
  while (i < text.length && bytes < minBytes) {
    const cp = codePointUtf8(text, i)
    bytes += cp.bytes
    i += cp.units
  }
  return { units: i, bytes }
}

/** Output caps below this keep the bare head/tail marker with no summary or evidence. */
const OUTPUT_SUMMARY_MIN_CAP_BYTES = 2048

/** Room reserved for the dropped-span summary line and the closing evidence line. */
const OUTPUT_SUMMARY_RESERVE_BYTES = 256

/** Share of the cap spent on evidence lines kept from the dropped middle. */
const OUTPUT_EVIDENCE_CAP_DIVISOR = 8

const OUTPUT_EVIDENCE_MAX_BYTES = 16 * 1024

/** Longest single evidence line kept; the rest of a longer line is elided. */
const OUTPUT_EVIDENCE_LINE_MAX_BYTES = 512

const OUTPUT_EVIDENCE_END = '[end of kept lines]\n'

/**
 * Evidence ranks, most important first: failures, warnings, then locations
 * (`file:line[:col]`, JS `at …` and Python `File "…", line N` frames). A line
 * takes the first rank any of its patterns match; ANSI styling is stripped
 * before matching so a coloured `error:` still counts.
 */
const EVIDENCE_PATTERNS: readonly (readonly RegExp[])[] = [
  [
    /\b(?:errors?|fail(?:s|ed|ure|ures|ing)?|panic(?:ked)?|traceback|exception|fatal|assertion|segmentation fault|not ok)\b|\bERR!/i,
    /\b[A-Z]\w*(?:Error|Exception)\b/,
  ],
  [/\bwarn(?:ing|ings|s)?\b/i],
  [
    /(?:^|[\s("'])(?:[\w.@~-]+\/)*[\w.@-]+\.[A-Za-z]\w*:\d+(?::\d+)?\b/,
    /^\s+at\s/,
    /^\s*File ".+", line \d+/,
  ],
]

/** Tallies that only say nothing went wrong (`0 errors`, `no warnings`). */
const EVIDENCE_NEGATIVE = /\b(?:0|no|zero)\s+(?:errors?|fail(?:ed|ures?)?|warnings?)\b/gi

/** Rank of an evidence line (index into {@link EVIDENCE_PATTERNS}), or null for ordinary output. */
export function evidenceRank(line: string): number | null {
  const plain = stripTerminalControlSequences(line)
  if (!plain.trim()) return null
  const withoutTallies = plain.replace(EVIDENCE_NEGATIVE, '')
  for (const [rank, patterns] of EVIDENCE_PATTERNS.entries()) {
    const subject = rank < 2 ? withoutTallies : plain
    if (patterns.some((pattern) => pattern.test(subject))) return rank
  }
  return null
}

interface EvidenceLine {
  readonly seq: number
  readonly text: string
  readonly bytes: number
}

/**
 * Bounded pool of the most important lines seen so far. When over budget it
 * evicts the lowest-ranked, latest line, so the result depends only on the
 * sequence of lines offered — never on how they were chunked.
 */
class EvidencePool {
  private readonly ranks: EvidenceLine[][] = EVIDENCE_PATTERNS.map(() => [])
  private bytes = 0
  private readonly budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  offer(rank: number, line: EvidenceLine): void {
    if (line.bytes > this.budget) return
    this.ranks[rank]?.push(line)
    this.bytes += line.bytes
    for (let r = this.ranks.length - 1; r >= 0 && this.bytes > this.budget; r--) {
      const lines = this.ranks[r] ?? []
      while (this.bytes > this.budget) {
        const worst = lines.pop()
        if (!worst) break
        this.bytes -= worst.bytes
      }
    }
  }

  clone(): EvidencePool {
    const copy = new EvidencePool(this.budget)
    for (const [rank, lines] of this.ranks.entries()) copy.ranks[rank] = [...lines]
    copy.bytes = this.bytes
    return copy
  }

  /** Kept lines in their original order. */
  lines(): EvidenceLine[] {
    return this.ranks.flat().sort((a, b) => a.seq - b.seq)
  }
}

export interface CappedOutputOptions {
  /**
   * Keep error / warning / `file:line` / stack-frame lines from the dropped
   * middle (within a fixed share of the cap). Off for prose such as web pages.
   */
  readonly evidence?: boolean
  /** One line appended to the summary telling the model how to see the rest. */
  readonly hint?: string
}

/**
 * Memory-bounded output (head + tail) for text a model reads. Output that fits
 * in `maxBytes` is kept verbatim. Past that, the head and tail are kept and the
 * middle is replaced by {@link COMMAND_OUTPUT_TRUNCATED_MARKER}, a line stating
 * how many bytes and lines were dropped, and (with `evidence`) the error,
 * warning and location lines from the dropped span. The result never exceeds
 * `maxBytes` and depends only on the full text, not on how it was chunked.
 *
 * Streamed deltas from {@link append} match what {@link toString} will contain,
 * aside from the summary and evidence lines that follow the marker.
 */
export class CappedOutputAccumulator {
  private head = ''
  private headBytes = 0
  private tail = ''
  private tailBytes = 0
  private truncated = false
  private droppedBytes = 0
  private droppedNewlines = 0
  private droppedEndsWithNewline = false
  private lineSeq = 0
  private pendingLine = ''
  private pendingLineBytes = 0
  private pendingLineElided = false
  private readonly headMax: number
  /** Tail size once something has been dropped. */
  private readonly tailMax: number
  private readonly summarise: boolean
  private readonly evidence: EvidencePool | null
  private readonly hint: string
  private readonly maxBytes: number

  constructor(maxBytes = COMMAND_OUTPUT_MAX_BYTES, options: CappedOutputOptions = {}) {
    this.maxBytes = maxBytes
    const markerBytes = utf8ByteLength(COMMAND_OUTPUT_TRUNCATED_MARKER)
    this.summarise = maxBytes >= OUTPUT_SUMMARY_MIN_CAP_BYTES
    this.hint = this.summarise && options.hint ? options.hint.replace(/\s+/g, ' ').trim() : ''
    const evidenceBudget =
      this.summarise && options.evidence === true
        ? Math.min(Math.floor(maxBytes / OUTPUT_EVIDENCE_CAP_DIVISOR), OUTPUT_EVIDENCE_MAX_BYTES)
        : 0
    this.evidence = evidenceBudget > 0 ? new EvidencePool(evidenceBudget) : null
    const reserve = this.summarise
      ? OUTPUT_SUMMARY_RESERVE_BYTES + utf8ByteLength(this.hint) + evidenceBudget
      : 0
    const budget = Math.max(0, maxBytes - markerBytes - reserve)
    this.headMax = Math.floor(budget / 2)
    this.tailMax = budget - this.headMax
  }

  /** Append a chunk; returns text that should be streamed to the UI. */
  append(chunk: string): string {
    if (!chunk) return ''

    let rest = chunk
    let emit = ''

    if (this.headBytes < this.headMax) {
      const fit = utf8PrefixFit(rest, this.headMax - this.headBytes)
      if (fit.units > 0) {
        const take = rest.slice(0, fit.units)
        this.head += take
        this.headBytes += fit.bytes
        emit += take
        rest = rest.slice(fit.units)
      }
      // A code point that does not fit closes the head so it cannot be filled
      // by a later, smaller one — the head is a prefix of the whole stream.
      if (rest) this.headBytes = this.headMax
    }

    if (!rest) return emit

    const combined = this.tail + rest
    const combinedBytes = this.tailBytes + utf8ByteLength(rest)
    // Until something is dropped the tail may use the whole remaining cap, so
    // output that fits in `maxBytes` is returned verbatim.
    const cap = this.truncated ? this.tailMax : this.maxBytes - this.headBytes
    if (combinedBytes <= cap) {
      this.tail = combined
      this.tailBytes = combinedBytes
      if (!this.truncated) emit += rest
      return emit
    }

    const limit = this.tailMax
    const cut = utf8PrefixCovering(combined, combinedBytes - limit)
    const dropped = combined.slice(0, cut.units)
    const kept = combined.slice(cut.units)
    // A slice of a large chunk would pin the whole chunk, so copy the tail out
    // (UTF-16 round-trip: lossless, unlike UTF-8 for a lone surrogate).
    this.tail = rest.length > limit ? Buffer.from(kept, 'utf16le').toString('utf16le') : kept
    this.tailBytes = combinedBytes - cut.bytes
    if (!this.truncated) {
      this.truncated = true
      emit += COMMAND_OUTPUT_TRUNCATED_MARKER
    }
    this.consumeDropped(dropped, cut.bytes)
    return emit
  }

  private consumeDropped(text: string, bytes: number): void {
    if (!text) return
    this.droppedBytes += bytes
    this.droppedEndsWithNewline = text.endsWith('\n')
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      const end = nl === -1 ? text.length : nl
      if (this.evidence) this.appendPendingLine(text.slice(start, end))
      if (nl === -1) break
      this.droppedNewlines++
      if (this.evidence) this.finishPendingLine(this.evidence)
      start = nl + 1
    }
  }

  private appendPendingLine(segment: string): void {
    if (!segment || this.pendingLineElided) return
    const room = OUTPUT_EVIDENCE_LINE_MAX_BYTES - this.pendingLineBytes
    const fit = utf8PrefixFit(segment, room)
    this.pendingLine += segment.slice(0, fit.units)
    this.pendingLineBytes += fit.bytes
    if (fit.units < segment.length) this.pendingLineElided = true
  }

  private finishPendingLine(pool: EvidencePool): void {
    const line = this.pendingLineElided ? `${this.pendingLine}…` : this.pendingLine
    const seq = this.lineSeq++
    this.pendingLine = ''
    this.pendingLineBytes = 0
    this.pendingLineElided = false
    const rank = evidenceRank(line)
    if (rank !== null) pool.offer(rank, { seq, text: line, bytes: utf8ByteLength(line) + 1 })
  }

  /** Whether any of the output was dropped. */
  isTruncated(): boolean {
    return this.truncated
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail
    if (!this.summarise) return this.head + COMMAND_OUTPUT_TRUNCATED_MARKER + this.tail

    let kept: EvidenceLine[] = []
    if (this.evidence) {
      // The dropped span's last line continues into the tail; offer the part we
      // have without mutating state, since toString may be called mid-stream.
      const pool = this.evidence.clone()
      if (this.pendingLine) {
        const line = this.pendingLineElided ? `${this.pendingLine}…` : this.pendingLine
        const rank = evidenceRank(line)
        if (rank !== null) {
          pool.offer(rank, { seq: this.lineSeq, text: line, bytes: utf8ByteLength(line) + 1 })
        }
      }
      kept = pool.lines()
    }

    const lines = this.droppedNewlines + (this.droppedEndsWithNewline ? 0 : 1)
    const keptNote =
      kept.length > 0
        ? `; ${String(kept.length)} error/warning/location line${kept.length === 1 ? '' : 's'} from that span kept below`
        : ''
    const hint = this.hint ? ` ${this.hint}` : ''
    const summary = `[dropped ${String(this.droppedBytes)} bytes (~${String(lines)} lines) from the middle${keptNote}.${hint}]\n`
    const evidence =
      kept.length > 0 ? kept.map((line) => `${line.text}\n`).join('') + OUTPUT_EVIDENCE_END : ''
    return this.head + COMMAND_OUTPUT_TRUNCATED_MARKER + summary + evidence + this.tail
  }
}

/**
 * One-shot form of {@link CappedOutputAccumulator} for a tool result that is
 * already a single string (fetched pages, MCP results, CI logs).
 */
export function truncateToolOutput(
  text: string,
  maxBytes = COMMAND_OUTPUT_MAX_BYTES,
  options: CappedOutputOptions = {},
): string {
  if (utf8ByteLength(text) <= maxBytes) return text
  const acc = new CappedOutputAccumulator(maxBytes, options)
  acc.append(text)
  return acc.toString()
}

/** Append to a string field without exceeding max UTF-8 bytes (head/tail truncation). */
export function appendFlatCapped(target: string, chunk: string, maxBytes: number): string {
  const combined = target + chunk
  if (utf8ByteLength(combined) <= maxBytes) return combined
  return truncateCommandOutput(combined, maxBytes)
}
