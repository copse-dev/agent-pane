import { isAmbiguousBlockLine } from './block-tokenizer.ts'
import { decodeSafeMarkdownEntities, escapeHtml } from './escape.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderProseInline } from './render-prose-inline.ts'

/** Document-level list marker (CommonMark: up to 3 spaces). */
const TOP_LEVEL_LIST_MARKER_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/
/** Indented sublist marker while the parent item is still open (4+ spaces). */
const INDENTED_LIST_MARKER_RE = /^ {4,}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/

function matchPendingListMarker(pending: string): RegExpMatchArray | null {
  return pending.match(TOP_LEVEL_LIST_MARKER_RE) ?? pending.match(INDENTED_LIST_MARKER_RE)
}

export function pendingListMarkerLength(pending: string): number | null {
  const match = matchPendingListMarker(pending)
  return match ? match[0].length : null
}

export function pendingListOrderedMarker(pending: string): string | null {
  const match = pending.match(/^ {0,3}(\d{1,9})[.)]\s/) ?? pending.match(/^ {4,}(\d{1,9})[.)]\s/)
  return match?.[1] ?? null
}

/** Inline markdown safe to show while streaming (hold index applied by caller). */
export function renderStreamingInline(text: string): string {
  return renderProseInline(text)
}

/**
 * Render the safe visible portion of a streaming pending tail. Block constructs
 * (lists, tables, headings) stay out of the DOM until their line/block completes;
 * list lines still resolve inline emphasis so `**` does not flash literally.
 */
export function renderPendingLine(pending: string): string {
  if (!pending) return ''

  const listMatch = matchPendingListMarker(pending)
  if (listMatch) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    const markerLen = listMatch[0].length
    if (visible.length <= markerLen) return ''
    return renderProseInline(visible.slice(markerLen))
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
  return renderProseInline(visible)
}
