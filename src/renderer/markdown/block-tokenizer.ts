/**
 * Block-level markdown tokenizer (#475). Identifies block boundaries and whether
 * each block is complete, open (unfinished), or ambiguous (needs more input).
 */

export type BlockKind =
  | 'blank'
  | 'paragraph'
  | 'atx_heading'
  | 'setext_heading'
  | 'thematic_break'
  | 'fence'
  | 'blockquote'
  | 'list_item'
  | 'table'

export type BlockStatus = 'complete' | 'open' | 'ambiguous'

export interface BlockToken {
  kind: BlockKind
  status: BlockStatus
  /** Inclusive start offset in the source string. */
  start: number
  /** Exclusive end offset in the source string. */
  end: number
}

export interface ScannedLine {
  text: string
  start: number
  end: number
  /** False for the final line when the source does not end with `\n`. */
  terminated: boolean
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?: |$)/
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/
const LIST_ITEM_RE = /^ {0,3}((?:[-*+])|(?:\d+\.))\s/
const BLOCKQUOTE_RE = /^ {0,3}> ?/
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/
export const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim() !== ''
}

function fenceMarker(line: string): { marker: string; len: number; info: string } | null {
  const m = line.match(FENCE_OPEN_RE)
  if (!m?.[1]) return null
  const marker = m[1]
  return { marker, len: marker.length, info: (m[2] ?? '').trim() }
}

function fenceCloses(marker: string, len: number, line: string): boolean {
  const m = line.match(FENCE_CLOSE_RE)
  if (!m?.[1] || m[1][0] !== marker[0]) return false
  return m[1].length >= len
}

/** Scan source into lines while preserving byte offsets. */
export function scanLines(source: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let i = 0
  while (i <= source.length) {
    const start = i
    const end = source.indexOf('\n', i)
    if (end === -1) {
      if (start < source.length) {
        lines.push({ text: source.slice(start), start, end: source.length, terminated: false })
      }
      break
    }
    lines.push({ text: source.slice(start, end), start, end: end + 1, terminated: true })
    i = end + 1
  }
  return lines
}

function pushBlock(
  blocks: BlockToken[],
  kind: BlockKind,
  status: BlockStatus,
  start: number,
  end: number,
): void {
  if (end <= start) return
  blocks.push({ kind, status, start, end })
}

/**
 * Tokenize block-level markdown. When the final line is not newline-terminated the
 * last block is marked `open` or `ambiguous` instead of `complete`.
 */
export function tokenizeBlocks(source: string): BlockToken[] {
  const lines = scanLines(source)
  const blocks: BlockToken[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line) break

    if (line.text.trim() === '') {
      pushBlock(blocks, 'blank', line.terminated ? 'complete' : 'open', line.start, line.end)
      i++
      continue
    }

    const fence = fenceMarker(line.text)
    if (fence) {
      const fenceStart = line.start
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const next = lines[j]
        if (next && fenceCloses(fence.marker, fence.len, next.text)) {
          closed = true
          pushBlock(blocks, 'fence', 'complete', fenceStart, next.end)
          i = j + 1
          break
        }
        j++
      }
      if (!closed) {
        const end = lines.at(-1)?.end ?? source.length
        pushBlock(blocks, 'fence', 'open', fenceStart, end)
        break
      }
      continue
    }

    if (ATX_HEADING_RE.test(line.text)) {
      const status: BlockStatus = line.terminated ? 'complete' : 'ambiguous'
      pushBlock(blocks, 'atx_heading', status, line.start, line.end)
      i++
      continue
    }

    if (THEMATIC_BREAK_RE.test(line.text)) {
      const status: BlockStatus = line.terminated ? 'complete' : 'ambiguous'
      pushBlock(blocks, 'thematic_break', status, line.start, line.end)
      i++
      continue
    }

    if (LIST_ITEM_RE.test(line.text)) {
      const itemStart = line.start
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        if (!next || next.text.trim() === '' || LIST_ITEM_RE.test(next.text)) break
        if (
          ATX_HEADING_RE.test(next.text) ||
          THEMATIC_BREAK_RE.test(next.text) ||
          fenceMarker(next.text) ||
          BLOCKQUOTE_RE.test(next.text) ||
          (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
        ) {
          break
        }
        j++
      }
      const last = lines[j - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'list_item', status, itemStart, last.end)
      i = j
      continue
    }

    if (BLOCKQUOTE_RE.test(line.text)) {
      const bqStart = line.start
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        if (!next || next.text.trim() === '') break
        if (!BLOCKQUOTE_RE.test(next.text) && !line.terminated) break
        if (
          !BLOCKQUOTE_RE.test(next.text) &&
          (ATX_HEADING_RE.test(next.text) ||
            LIST_ITEM_RE.test(next.text) ||
            fenceMarker(next.text) ||
            THEMATIC_BREAK_RE.test(next.text))
        ) {
          break
        }
        j++
      }
      const last = lines[j - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'blockquote', status, bqStart, last.end)
      i = j
      continue
    }

    if (isTableRow(line.text) && lines[i + 1] && TABLE_SEP_RE.test(lines[i + 1]?.text ?? '')) {
      const tableStart = line.start
      let j = i + 2
      while (j < lines.length) {
        const row = lines[j]
        if (!row || !isTableRow(row.text)) break
        j++
      }
      const last = lines[j - 1] ?? lines[i + 1] ?? line
      const lastRow = lines[j - 1]
      const status: BlockStatus =
        lastRow && !lastRow.terminated && j === lines.length ? 'open' : 'complete'
      pushBlock(blocks, 'table', status, tableStart, last.end)
      i = j
      continue
    }

    // Setext heading: text line followed by === or --- on the next line.
    const nextLine = lines[i + 1]
    if (nextLine && SETEXT_UNDERLINE_RE.test(nextLine.text)) {
      const status: BlockStatus = nextLine.terminated ? 'complete' : 'ambiguous'
      pushBlock(blocks, 'setext_heading', status, line.start, nextLine.end)
      i += 2
      continue
    }

    // Final line without newline: open paragraph (setext text line is still open
    // until a following ===/--- line arrives, handled above).
    if (!line.terminated && i === lines.length - 1) {
      pushBlock(blocks, 'paragraph', 'open', line.start, line.end)
      break
    }

    // Paragraph: collect consecutive non-blank lines until a block boundary.
    const paraStart = line.start
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (!next || next.text.trim() === '') break
      if (
        ATX_HEADING_RE.test(next.text) ||
        THEMATIC_BREAK_RE.test(next.text) ||
        LIST_ITEM_RE.test(next.text) ||
        BLOCKQUOTE_RE.test(next.text) ||
        fenceMarker(next.text) ||
        (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? '')) ||
        (lines[j + 1] && SETEXT_UNDERLINE_RE.test(lines[j + 1]?.text ?? ''))
      ) {
        break
      }
      j++
    }
    const last = lines[j - 1] ?? line
    const status: BlockStatus = last.terminated ? 'complete' : 'open'
    pushBlock(blocks, 'paragraph', status, paraStart, last.end)
    i = j
  }

  return blocks
}

/** Index of the first character that must stay in the pending region. */
export function streamingHoldStart(blocks: BlockToken[]): number {
  let commitEnd = 0
  for (const block of blocks) {
    if (block.status !== 'complete') return block.start
    commitEnd = block.end
  }
  return commitEnd
}

/** True when `complete` ends inside a GFM table that may still receive body rows. */
export function completeEndsInOpenTable(complete: string): boolean {
  const blocks = tokenizeBlocks(complete)
  const last = blocks.at(-1)
  return last?.kind === 'table' && last.status === 'complete'
}

export function pendingLineBelongsInTable(complete: string, pending: string): boolean {
  return pending.includes('|') && completeEndsInOpenTable(complete)
}

/** Split a GFM table row into cell strings (leading/trailing pipes optional). */
export function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** Whether the pending tail should stay escaped plain text (block not yet safe). */
export function isAmbiguousBlockLine(line: string): boolean {
  const trimmed = line.trimStart()
  if (trimmed === '') return false
  if (ATX_HEADING_RE.test(line)) return true
  if (THEMATIC_BREAK_RE.test(line)) return true
  if (FENCE_OPEN_RE.test(line)) return true
  if (LIST_ITEM_RE.test(line)) return true
  if (BLOCKQUOTE_RE.test(line)) return true
  if (isTableRow(line)) return true
  return false
}
