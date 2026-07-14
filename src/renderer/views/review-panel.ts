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
    case 'skipped':
      return 'Review skipped'
    default:
      return 'Review'
  }
}

function isCleanReview(review: ThreadReview): boolean {
  return review.status === 'done' && review.issuesFound === false
}

function createReviewHeader(review: ThreadReview, onRetry?: () => void): HTMLElement {
  const header = el('summary', { class: 'review-panel-header' })
  header.append(
    el(
      'span',
      { class: 'review-panel-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    el('span', { class: 'review-panel-title' }, statusLabel(review.status)),
  )
  if (review.status === 'error' && onRetry) {
    header.append(createRetryButton(onRetry))
  }
  return header
}

function createReviewBody(review: ThreadReview, api: ApiClient): HTMLElement {
  const body = el('div', { class: 'review-panel-body message-text streaming-markdown' })
  body.innerHTML = renderMarkdown(review.summary || '(no review output)')
  void annotateFileReferences(body, api)
  return body
}

/** Compact card summarising the post-turn review verdict for a thread. */
export function createReviewCardEl(
  review: ThreadReview,
  api: ApiClient,
  onRetry?: () => void,
): HTMLElement {
  if (review.status === 'running') {
    const panel = el('div', {
      class: `review-panel review-panel-${review.status}`,
      'data-status': review.status,
    })
    const header = el('div', { class: 'review-panel-header' })
    header.append(
      el(
        'span',
        { class: 'review-panel-icon', 'aria-hidden': 'true' },
        searchIcon('ui-icon ui-icon-sm'),
      ),
      el('span', { class: 'review-panel-title' }, statusLabel(review.status)),
    )
    panel.append(header)
    return panel
  }

  if (isCleanReview(review)) {
    const details = el('details', {
      class: `review-panel review-panel-${review.status} review-panel-collapsible`,
      'data-status': review.status,
    })
    details.append(createReviewHeader(review), createReviewBody(review, api))
    return details
  }

  const panel = el('div', {
    class: `review-panel review-panel-${review.status}`,
    'data-status': review.status,
  })
  const header = el('div', { class: 'review-panel-header' })
  header.append(
    el(
      'span',
      { class: 'review-panel-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    el('span', { class: 'review-panel-title' }, statusLabel(review.status)),
  )
  if (review.status === 'error' && onRetry) {
    header.append(createRetryButton(onRetry))
  }
  panel.append(header, createReviewBody(review, api))
  return panel
}
