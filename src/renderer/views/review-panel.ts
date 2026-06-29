import { el } from '../dom/helpers.ts'
import type { ThreadReview } from '@shared/types'
import { renderMarkdown } from '../markdown/renderer.ts'
import { sanitizeRenderedMarkdown } from '../markdown/sanitize.ts'
import { annotateFileReferences } from '../markdown/file-links.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function statusLabel(status: ThreadReview['status']): string {
  switch (status) {
    case 'running':
      return 'Reviewing…'
    case 'error':
      return 'Review failed'
    default:
      return 'Review'
  }
}

/** Compact card summarising the post-turn review verdict for a thread. */
export function createReviewCardEl(review: ThreadReview, api: ApiClient): HTMLElement {
  const panel = el('div', {
    class: `review-panel review-panel-${review.status}`,
    'data-status': review.status,
  })

  const header = el('div', { class: 'review-panel-header' })
  header.append(
    el('span', { class: 'review-panel-icon', 'aria-hidden': 'true' }, '🔍'),
    el('span', { class: 'review-panel-title' }, statusLabel(review.status)),
  )
  panel.append(header)

  if (review.status === 'running') return panel

  const body = el('div', { class: 'review-panel-body message-text' })
  body.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(review.summary || '(no review output)'))
  // Linkify printed file paths in the review subagent's output so they open in
  // the explorer, matching main-chat assistant text. Click handling is already
  // delegated from the conversation root (bindFileReferenceClicks) that this
  // card is mounted under.
  void annotateFileReferences(body, api)
  panel.append(body)
  return panel
}
