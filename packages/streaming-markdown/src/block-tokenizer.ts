/**
 * Block-level markdown tokenizer (#475). Identifies block boundaries and whether
 * each block is complete, open (unfinished), or ambiguous (needs more input).
 */
import { parseLinkReferenceDefinitions } from './link-references.ts'
import {
  ATX_HEADING_DETECT_RE as ATX_HEADING_RE,
  FENCE_OPEN_RE,
  fenceCloses,
  fenceMarker,
  leadingIndentWidth,
} from './block-patterns.ts'

export type BlockKind =
  | 'blank'
  | 'paragraph'
  | 'indented_code'
  | 'atx_heading'
  | 'setext_heading'
  | 'thematic_break'
  | 'fence'
  | 'blockquote'
  | 'list_item'
  | 'table'
  | 'link_ref_def'

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

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const UNORDERED_LIST_ITEM_RE = /^ {0,3}[-*+](?:\s|$)/
const ORDERED_LIST_MARKER_RE = /^ {0,3}(\d{1,9})([.)])\s/
const LIST_ITEM_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/
const BLOCKQUOTE_RE = /^ {0,3}> ?/
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/
export const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Parse a valid ordered-list marker (1–9 digits); returns null for invalid markers like 10-digit #266. */
export function parseOrderedListMarker(line: string): number | null {
  const m = line.match(ORDERED_LIST_MARKER_RE)
  if (!m?.[1]) return null
  return parseInt(m[1], 10)
}

export function orderedListMarkerDelimiter(line: string): '.' | ')' | null {
  const m = line.match(ORDERED_LIST_MARKER_RE)
  const d = m?.[2]
  if (d === '.' || d === ')') return d
  return null
}

export function isUnorderedListItemLine(line: string): boolean {
  return UNORDERED_LIST_ITEM_RE.test(line)
}

export function isListItemLine(line: string): boolean {
  return isUnorderedListItemLine(line) || parseOrderedListMarker(line) !== null
}

export function unorderedListMarkerChar(line: string): '-' | '*' | '+' | null {
  const m = line.match(/^ {0,3}([-*+])\s/)
  const ch = m?.[1]
  if (ch === '-' || ch === '*' || ch === '+') return ch
  return null
}

/** Column of the first content character in a list item line (#255 vs #256, #276). */
export function listItemContentColumn(line: string): number {
  const ordered = line.match(/^ {0,3}\d{1,9}[.)]\s*/)
  if (ordered) {
    const rest = line.slice(ordered[0].length)
    const leadingSpaces = rest.match(/^ */)?.[0].length ?? 0
    return ordered[0].length + leadingSpaces
  }
  const marker = line.match(/^ {0,3}[-*+]\s*/)
  if (!marker) return Infinity
  const rest = line.slice(marker[0].length)
  const leadingSpaces = rest.match(/^ */)?.[0].length ?? 0
  return marker[0].length + leadingSpaces
}

function lazyContinuationIndent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0
}

/** Ordered marker mid-paragraph (#304): only `1` may interrupt; other markers continue. */
function orderedMarkerContinuesParagraph(prevLine: string, line: string): boolean {
  const num = parseOrderedListMarker(line)
  if (num === null) return false
  if (num === 1) return false
  return prevLine.trimEnd().length > 0
}

function isLazyUnorderedContinuation(itemStartLine: string, line: string): boolean {
  if (isListItemLine(line)) return false
  return lazyContinuationIndent(line) >= listItemContentColumn(itemStartLine)
}

/** True when `line` continues the open list item started on `itemStartLine`. */
export function isLazyListContinuation(itemStartLine: string, line: string): boolean {
  return isLazyUnorderedContinuation(itemStartLine, line)
}

function lineContainsPipeCellDelimiter(line: string): boolean {
  return line.includes('|') && line.trim() !== ''
}

/** Prose metadata lines use inline pipes as separators, not GFM table cells. */
function isProseMetadataPipeLine(line: string): boolean {
  if (!lineContainsPipeCellDelimiter(line)) return false
  const trimmed = line.trimStart()
  if (/\*\*[^*\n]+:\*\*/.test(trimmed)) return true
  if (/&nbsp;/i.test(trimmed)) return true
  return false
}

/** True when a line participates in GFM table syntax (not prose metadata with inline pipes). */
export function isGfmTableRowLine(line: string): boolean {
  if (!lineContainsPipeCellDelimiter(line)) return false
  if (isProseMetadataPipeLine(line)) return false
  const trimmed = line.trimStart()
  if (trimmed.startsWith('|')) return true
  return splitTableRow(trimmed).length >= 2
}

function isTableRow(line: string): boolean {
  return isGfmTableRowLine(line)
}

/** Separator line still streaming (e.g. `| -` before the full `| - | - |`). */
function isPartialTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-{1,}/.test(trimmed)
}

/**
 * True when a pipe row may be the start of a GFM table that is not yet safe to
 * render (no confirmed separator). Avoids treating `| A | B |` as prose while
 * streaming.
 */
export function isPotentialTableStart(lines: ScannedLine[], i: number): boolean {
  const line = lines[i]
  if (!line || !isTableRow(line.text)) return false
  const next = lines[i + 1]
  if (next && TABLE_SEP_RE.test(next.text)) return true
  if (next && isPartialTableSeparatorLine(next.text)) return true
  if (next && isTableRow(next.text)) return true
  return line.text.trimStart().startsWith('|')
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

function tryLinkRefDefBlock(lines: ScannedLine[], i: number): number | null {
  const startLine = lines[i]
  if (!startLine || !/^ {0,3}\[/.test(startLine.text)) return null
  let j = i
  let buf = ''
  while (j < lines.length) {
    const line = lines[j]
    if (!line) break
    if (j > i && line.text.trim() === '') return null
    if (
      j > i &&
      (ATX_HEADING_RE.test(line.text) ||
        LIST_ITEM_RE.test(line.text) ||
        BLOCKQUOTE_RE.test(line.text) ||
        fenceMarker(line.text) ||
        THEMATIC_BREAK_RE.test(line.text))
    ) {
      return null
    }
    buf += line.text
    if (line.terminated) buf += '\n'
    if (/\]:[ \t]/.test(buf) || /\]:\n/.test(buf)) {
      const probe = buf.endsWith('\n') ? buf : `${buf}\n`
      if (parseLinkReferenceDefinitions(probe).size > 0) return j + 1
    }
    j++
  }
  return null
}

function breaksUnorderedListItem(lines: ScannedLine[], itemStart: number, j: number): boolean {
  const itemStartLine = lines[itemStart]?.text ?? ''
  const col = listItemContentColumn(itemStartLine)
  const next = lines[j]
  if (!next) return true
  if (next.text.trim() === '') {
    let k = j + 1
    while (k < lines.length && lines[k]?.text.trim() === '') k++
    const after = lines[k]
    if (!after) return true
    // Indented at least to the content column → still inside this item
    // (nested list, indented code, fence, blockquote, ...).
    if (lazyContinuationIndent(after.text) >= col) return false
    if (isListItemLine(after.text)) return true
    return !isLazyUnorderedContinuation(itemStartLine, after.text)
  }
  if (lazyContinuationIndent(next.text) >= col && next.text.trim() !== '') return false
  if (isListItemLine(next.text)) return true
  if (
    ATX_HEADING_RE.test(next.text) ||
    THEMATIC_BREAK_RE.test(next.text) ||
    fenceMarker(next.text) ||
    BLOCKQUOTE_RE.test(next.text) ||
    tryLinkRefDefBlock(lines, j) !== null ||
    (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
  ) {
    return true
  }
  return false
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

    // Indented code block (4+ spaces at a block start; cannot interrupt a
    // paragraph — the paragraph collector consumes indented continuations).
    if (leadingIndentWidth(line.text) >= 4 && line.text.trim() !== '') {
      let j = i + 1
      let lastContent = i
      while (j < lines.length) {
        const next = lines[j]
        if (!next) break
        if (next.text.trim() === '') {
          j++
          continue
        }
        if (leadingIndentWidth(next.text) >= 4) {
          lastContent = j
          j++
          continue
        }
        break
      }
      const last = lines[lastContent] ?? line
      const terminatorSeen = j < lines.length && lines[j] !== undefined
      const status: BlockStatus = !last.terminated ? 'open' : terminatorSeen ? 'complete' : 'open'
      pushBlock(blocks, 'indented_code', status, line.start, last.end)
      i = lastContent + 1
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

    const linkRefEnd = tryLinkRefDefBlock(lines, i)
    if (linkRefEnd !== null) {
      const last = lines[linkRefEnd - 1] ?? line
      const status: BlockStatus = last.terminated ? 'complete' : 'open'
      pushBlock(blocks, 'link_ref_def', status, line.start, last.end)
      i = linkRefEnd
      continue
    }

    if (isListItemLine(line.text)) {
      const isOrdered = parseOrderedListMarker(line.text) !== null
      const itemStart = line.start
      let j = i + 1
      while (j < lines.length) {
        if (isOrdered) {
          const next = lines[j]
          if (!next) break
          if (
            next.text.trim() !== '' &&
            lazyContinuationIndent(next.text) >= listItemContentColumn(line.text)
          ) {
            j++
            continue
          }
          if (isListItemLine(next.text)) break
          if (next.text.trim() === '') {
            j++
            continue
          }
          if (
            ATX_HEADING_RE.test(next.text) ||
            THEMATIC_BREAK_RE.test(next.text) ||
            fenceMarker(next.text) ||
            BLOCKQUOTE_RE.test(next.text) ||
            tryLinkRefDefBlock(lines, j) !== null ||
            (isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? ''))
          ) {
            break
          }
          j++
          continue
        }
        if (breaksUnorderedListItem(lines, i, j)) break
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
        if (!next) break
        if (next.text.trim() === '') {
          let k = j + 1
          while (k < lines.length && lines[k]?.text.trim() === '') k++
          if (k < lines.length && lines[k] && BLOCKQUOTE_RE.test(lines[k]?.text ?? '')) {
            j++
            continue
          }
          break
        }
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

    if (isTableRow(line.text)) {
      const nextLine = lines[i + 1]
      if (nextLine && TABLE_SEP_RE.test(nextLine.text)) {
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

      if (isPotentialTableStart(lines, i)) {
        const tableStart = line.start
        let j = i + 1
        while (j < lines.length) {
          const nl = lines[j]
          if (!nl) break
          if (TABLE_SEP_RE.test(nl.text)) break
          if (
            !isTableRow(nl.text) &&
            !isPartialTableSeparatorLine(nl.text) &&
            nl.text.trim() !== ''
          ) {
            break
          }
          j++
        }
        const last = lines[j - 1] ?? line
        const status: BlockStatus =
          last.terminated && j > i + 1 ? 'open' : last.terminated ? 'ambiguous' : 'open'
        pushBlock(blocks, 'table', status, tableStart, last.end)
        i = j
        continue
      }
    }

    // Setext heading: text line followed by === or --- on the next line.
    const nextLine = lines[i + 1]
    if (nextLine && SETEXT_UNDERLINE_RE.test(nextLine.text)) {
      if (!nextLine.terminated) {
        // While `---` / `===` is still streaming, keep the text line visible as
        // prose and hold the underline as a pending thematic candidate. Treating
        // the pair as an ambiguous setext block would hide committed paragraphs.
        pushBlock(blocks, 'paragraph', line.terminated ? 'complete' : 'open', line.start, line.end)
        pushBlock(blocks, 'thematic_break', 'ambiguous', nextLine.start, nextLine.end)
        i += 2
        continue
      }
      pushBlock(blocks, 'setext_heading', 'complete', line.start, nextLine.end)
      i += 2
      continue
    }

    // Final line without newline: open paragraph (setext text line is still open
    // until a following ===/--- line arrives, handled above).
    if (!line.terminated && i === lines.length - 1) {
      if (isPotentialTableStart(lines, i)) {
        pushBlock(blocks, 'table', 'ambiguous', line.start, line.end)
      } else {
        pushBlock(blocks, 'paragraph', 'open', line.start, line.end)
      }
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
        (LIST_ITEM_RE.test(next.text) &&
          !orderedMarkerContinuesParagraph(lines[j - 1]?.text ?? '', next.text)) ||
        BLOCKQUOTE_RE.test(next.text) ||
        fenceMarker(next.text) ||
        tryLinkRefDefBlock(lines, j) !== null ||
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

/** Source slice for a table block that is not yet `complete` (forming or open body). */
export function getIncompleteTableSource(content: string): string | null {
  const blocks = tokenizeBlocks(content)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind === 'table' && block.status !== 'complete') {
      return content.slice(block.start, block.end)
    }
  }
  return null
}

/** Source slice for a fenced code block that is not yet `complete`. */
export function getIncompleteFenceSource(content: string): string | null {
  const blocks = tokenizeBlocks(content)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind === 'fence' && block.status !== 'complete') {
      return content.slice(block.start, block.end)
    }
  }
  return null
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
  if (/^ {4}/.test(line)) return true
  if (ATX_HEADING_RE.test(line)) return true
  if (THEMATIC_BREAK_RE.test(line)) return true
  if (FENCE_OPEN_RE.test(line)) return true
  if (LIST_ITEM_RE.test(line)) return true
  if (BLOCKQUOTE_RE.test(line)) return true
  if (isGfmTableRowLine(line)) return true
  return false
}
