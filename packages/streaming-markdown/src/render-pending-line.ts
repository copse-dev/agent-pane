import {
  ATX_HEADING_CAPTURE_RE,
  BLOCKQUOTE_DETECT_RE,
  stripAtxClosingHashes,
  stripBlockquoteMarker,
} from './block-patterns.ts'
import {
  isAmbiguousBlockLine,
  isLazyListContinuation,
  listItemContentColumn,
} from './block-tokenizer.ts'
import { decodeSafeMarkdownEntities, escapeHtml } from './escape.ts'
import { scanCodeSpans } from './inline-code-spans.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderProseInline } from './render-prose-inline.ts'

// A complete inline link/image at the start of the slice (`[a](/x)` / `![a](/x)`).
const COMPLETE_LINK_AT_START_RE = /^!?\[[^\]]*\]\([^)]*\)/

/**
 * Streaming: reveal a forming link's label before its URL arrives (#617).
 *
 * While `[label](https://partial` streams, the raw text otherwise shows literal
 * `[`/`](` brackets and — worse — autolinks the partial URL into a broken,
 * clickable `<a>`. This surfaces the label text as soon as it is unambiguous and
 * drops the incomplete `](url` tail so no partial URL renders or navigates.
 * Once `](url)` closes, the complete link is left untouched for normal rendering.
 *
 * Only the trailing, still-forming link/image is touched; earlier complete links
 * and `[label]` shortcut/literal brackets are left as-is, and `[` inside code
 * spans or after a backslash escape never counts.
 */
export function revealFormingLink(text: string): string {
  if (!text.includes('[')) return text
  const { mask } = scanCodeSpans(text)
  let open = -1
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '[' || mask[i]) continue
    let backslashes = 0
    for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) backslashes++
    if (backslashes % 2 === 1) continue // escaped `\[` is literal
    open = i
    break
  }
  if (open === -1) return text

  const isImage = open > 0 && text[open - 1] === '!'
  const startIdx = isImage ? open - 1 : open
  // A complete link/image starts here → nothing is forming at the tail.
  if (COMPLETE_LINK_AT_START_RE.test(text.slice(startIdx))) return text

  const afterBracket = text.slice(open + 1)
  const closeRel = afterBracket.indexOf(']')
  if (closeRel === -1) {
    // `[label` — bracket opened, no close yet: show the label text.
    return text.slice(0, startIdx) + afterBracket
  }
  const label = afterBracket.slice(0, closeRel)
  const afterClose = afterBracket.slice(closeRel + 1)
  if (afterClose.startsWith('(')) {
    // `[label](partial` — destination opened but unclosed: label only.
    return text.slice(0, startIdx) + label
  }
  // `[label]` (shortcut ref / literal) — leave for normal inline rendering.
  return text
}

/** Document-level list marker (CommonMark: up to 3 spaces). */
const TOP_LEVEL_LIST_MARKER_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/
/** Marker typed but missing required whitespace (`-item` / `*item`, not `**bold**` or `---`). */
function isIncompleteListMarkerPrefix(pending: string): boolean {
  return (
    /^ {0,3}-(?=[^\s-\n])/.test(pending) ||
    /^ {0,3}\*(?!\*)(?=[^\s\n])/.test(pending) ||
    /^ {0,3}\+(?=[^\s\n])/.test(pending)
  )
}

function matchPendingListMarker(pending: string): RegExpMatchArray | null {
  return pending.match(TOP_LEVEL_LIST_MARKER_RE)
}

function dedentLazyContinuation(text: string, itemFirstLine: string): string {
  const col = listItemContentColumn(itemFirstLine)
  return text
    .split('\n')
    .map((line) => {
      const indent = line.match(/^ */)?.[0].length ?? 0
      return line.slice(Math.min(indent, col))
    })
    .join('\n')
}

/** Strip up to three leading spaces per line (CommonMark paragraph normalization). */
function stripParagraphIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^ {0,3}(?=\S)/, ''))
    .join('\n')
}

export function pendingListMarkerLength(pending: string): number | null {
  const match = matchPendingListMarker(pending)
  return match ? match[0].length : null
}

export function pendingListOrderedMarker(pending: string): string | null {
  const match = pending.match(/^ {0,3}(\d{1,9})[.)]\s/)
  return match?.[1] ?? null
}

/** Leading spaces before a list marker on the pending line (0 = document-level item). */
export function listPendingIndent(pending: string): number {
  return pending.match(/^ */)?.[0].length ?? 0
}

export function pendingAtxHeadingLevel(pending: string): number | null {
  const match = pending.match(ATX_HEADING_CAPTURE_RE)
  return match?.[1] ? match[1].length : null
}

function pendingAtxHeadingTitle(pending: string): string {
  const match = pending.match(ATX_HEADING_CAPTURE_RE)
  if (!match?.[1]) return ''
  return stripAtxClosingHashes((match[2] ?? '').trimEnd())
}

export function isPendingBlockquoteLine(pending: string): boolean {
  return BLOCKQUOTE_DETECT_RE.test(pending)
}

function pendingBlockquoteBody(pending: string): string {
  return stripBlockquoteMarker(pending)
}

export function isListContinuationPending(
  pending: string,
  openListItemFirstLine?: string,
): boolean {
  return (
    openListItemFirstLine !== undefined &&
    openListItemFirstLine !== '' &&
    isLazyListContinuation(openListItemFirstLine, pending)
  )
}

/** Inline markdown safe to show while streaming (hold index applied by caller). */
export function renderStreamingInline(text: string): string {
  return renderProseInline(revealFormingLink(text))
}

export interface RenderPendingLineOptions {
  openListItemFirstLine?: string
}

/**
 * Render the safe visible portion of a streaming pending tail. Block constructs
 * (lists, tables, headings) stay out of the DOM until their line/block completes;
 * list lines still resolve inline emphasis so `**` does not flash literally.
 */
export function renderPendingLine(pending: string, options: RenderPendingLineOptions = {}): string {
  if (!pending) return ''

  const { openListItemFirstLine } = options

  if (isListContinuationPending(pending, openListItemFirstLine)) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    const dedented = dedentLazyContinuation(visible, openListItemFirstLine ?? '')
    return renderStreamingInline(dedented)
  }

  const listMatch = matchPendingListMarker(pending)
  if (listMatch) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    const markerLen = listMatch[0].length
    if (visible.length <= markerLen) return ''
    return renderStreamingInline(visible.slice(markerLen))
  }

  if (isIncompleteListMarkerPrefix(pending)) {
    return ''
  }

  if (pendingAtxHeadingLevel(pending) !== null) {
    const title = pendingAtxHeadingTitle(pending)
    if (!title) return ''
    const hold = pendingHoldIndex(title)
    const visible = title.slice(0, hold)
    if (!visible) return ''
    return renderStreamingInline(visible)
  }

  if (isPendingBlockquoteLine(pending)) {
    const body = pendingBlockquoteBody(pending)
    if (!body.trim()) return ''
    const hold = pendingHoldIndex(body)
    const visible = body.slice(0, hold)
    if (!visible) return ''
    return renderStreamingInline(visible)
  }

  if (isAmbiguousBlockLine(pending)) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    return escapeHtml(decodeSafeMarkdownEntities(visible))
  }

  const hold = pendingHoldIndex(pending)
  const visible = pending.slice(0, hold)
  if (!visible) return ''
  return renderStreamingInline(stripParagraphIndent(visible))
}
