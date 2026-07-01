import { isAmbiguousBlockLine } from './block-tokenizer.ts'
import { escapeHtml } from './escape.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderProseInline } from './render-prose-inline.ts'

const LIST_ITEM_PREFIX_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/

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

  const listMatch = pending.match(LIST_ITEM_PREFIX_RE)
  if (listMatch) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    const markerLen = listMatch[0].length
    if (visible.length <= markerLen) return escapeHtml(visible)
    return escapeHtml(pending.slice(0, markerLen)) + renderProseInline(visible.slice(markerLen))
  }

  if (isAmbiguousBlockLine(pending)) {
    const hold = pendingHoldIndex(pending)
    const visible = pending.slice(0, hold)
    if (!visible) return ''
    return escapeHtml(visible)
  }

  const hold = pendingHoldIndex(pending)
  const visible = pending.slice(0, hold)
  if (!visible) return ''
  return renderProseInline(visible)
}
