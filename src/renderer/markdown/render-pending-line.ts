import { renderArtifactImageTags } from './artifact-images.ts'
import { isAmbiguousBlockLine } from './block-tokenizer.ts'
import { escapeHtml } from './escape.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { renderInlineSpans } from './inline-spans.ts'

const LIST_ITEM_PREFIX_RE = /^ {0,3}(?:[-*+]|\d+\.)\s/

function renderPendingProseInline(text: string): string {
  const body = text.replace(/<!--[\s\S]*?-->/g, '')
  return renderInlineSpans(renderArtifactImageTags(escapeHtml(body))).replace(/\n/g, '<br>')
}

/** Inline markdown safe to show while streaming (hold index applied by caller). */
export function renderStreamingInline(text: string): string {
  return renderPendingProseInline(text)
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
    return (
      escapeHtml(pending.slice(0, markerLen)) + renderPendingProseInline(visible.slice(markerLen))
    )
  }

  if (isAmbiguousBlockLine(pending)) return ''

  const hold = pendingHoldIndex(pending)
  const visible = pending.slice(0, hold)
  if (!visible) return ''
  return renderPendingProseInline(visible)
}
