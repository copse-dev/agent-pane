import { el } from '../dom/helpers.ts'
import { searchIcon } from '../dom/icons.ts'
import { createRetryButton } from './retry-button.ts'
import type { ThreadReview } from '@shared/types'
import { renderMarkdown } from '@copse/streaming-markdown'
import { annotateFileReferences } from '../markdown/file-links.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function statusLabel(status: ThreadReview['status']): string {
  switch (status) {
    case 'running':
      return 'Reviewing…'
    case 'error':
      return 'Review failed'
    // Not reached from the transcript today: mountConversation renders no card
    // for a skipped review. Kept so this label stays total over every status a
    // ThreadReview can carry, rather than a skipped card silently reading as a
    // finished "Review" if a caller ever renders one.
    case 'skipped':
      return 'Review skipped'
    default:
      return 'Review'
  }
}

/** Clean reviews (explicit `issuesFound: false`) collapse by default so a
 * positive verdict stays out of the way; reviews with findings (or unknown
 * legacy verdicts without the structured signal) stay expanded. */
function shouldCollapseCleanReview(review: ThreadReview): boolean {
  return review.status === 'done' && review.issuesFound === false
}

function appendReviewHeader(panel: HTMLElement, review: ThreadReview, onRetry?: () => void): void {
  const header = el(shouldCollapseCleanReview(review) ? 'summary' : 'div', {
    class: 'review-panel-header',
  })
  header.append(
    el(
      'span',
      { class: 'review-panel-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    el('span', { class: 'review-panel-title' }, statusLabel(review.status)),
  )
  // A failed review is usually recoverable in place (the local model server had
  // the wrong model loaded, a transient provider error): offer a one-click
  // re-run rather than making the user re-send the whole turn.
  if (review.status === 'error' && onRetry) {
    header.append(createRetryButton(onRetry))
  }
  panel.append(header)
}

/** Compact card summarising the post-turn review verdict for a thread. */
export function createReviewCardEl(
  review: ThreadReview,
  api: ApiClient,
  onRetry?: () => void,
): HTMLElement {
  const collapse = shouldCollapseCleanReview(review)
  const panel = el(collapse ? 'details' : 'div', {
    class: `review-panel review-panel-${review.status}`,
    'data-status': review.status,
    ...(review.issuesFound !== undefined
      ? { 'data-issues-found': review.issuesFound ? 'true' : 'false' }
      : {}),
  })

  appendReviewHeader(panel, review, onRetry)

  if (review.status === 'running') return panel

  const body = el('div', { class: 'review-panel-body message-text streaming-markdown' })
  // The verdict asked for follow-up but the turn stopped without acting on it
  // (cancelled, out of passes, out of budget, no-op remediation) — say why, so
  // a "not done" review never reads as silently ignored (#2506). Folded into
  // the same markdown as an italic closing line rather than a new styled
  // element, so it needs no new CSS (a global stylesheet change would map — by
  // design — to every screenshot-producing e2e spec, not just this card's).
  const bodyMarkdown = review.followUpNote
    ? `${review.summary || '(no review output)'}\n\n*${review.followUpNote}*`
    : review.summary || '(no review output)'
  body.innerHTML = renderMarkdown(bodyMarkdown)
  // Linkify printed file paths in the review subagent's output so they open in
  // the explorer, matching main-chat assistant text. Click handling is already
  // delegated from the conversation root (bindFileReferenceClicks) that this
  // card is mounted under.
  void annotateFileReferences(body, api)
  panel.append(body)

  return panel
}
