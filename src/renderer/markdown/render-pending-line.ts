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
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderProseInline } from './render-prose-inline.ts'

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
  return renderProseInline(text)
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
    return renderProseInline(dedented)
  }

  const listMatch = matchPendingListMarker(pending)
  if (listMatch) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    const markerLen = listMatch[0].length
    if (visible.length <= markerLen) return ''
    return renderProseInline(visible.slice(markerLen))
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
    return renderProseInline(visible)
  }

  if (isPendingBlockquoteLine(pending)) {
    const body = pendingBlockquoteBody(pending)
    if (!body.trim()) return ''
    const hold = pendingHoldIndex(body)
    const visible = body.slice(0, hold)
    if (!visible) return ''
    return renderProseInline(visible)
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
  return renderProseInline(stripParagraphIndent(visible))
}
