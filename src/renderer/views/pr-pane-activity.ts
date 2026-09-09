import type { GhPrActivity } from '@shared/types/git.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { clear, el } from '../dom/helpers.ts'

export type PrDetailSection = 'overview' | 'comments' | 'checks'

function readableState(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ')
}

function checkTone(state: string): string {
  if (['SUCCESS', 'NEUTRAL'].includes(state)) return 'success'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(state)) return 'failure'
  if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'].includes(state)) return 'pending'
  return 'unknown'
}

function externalButton(
  label: string,
  url: string | null,
  open: (url: string) => void,
): HTMLElement {
  // Check providers can return external URLs; never turn an arbitrary scheme
  // from remote content into a shell.openExternal action.
  if (!url || !/^https?:\/\//i.test(url)) return el('span', {}, label)
  const button = el('button', { type: 'button', class: 'pr-activity-link' }, label)
  button.addEventListener('click', () => {
    open(url)
  })
  return button
}

export function renderPrActivity(
  host: HTMLElement,
  section: 'comments' | 'checks',
  activity: GhPrActivity | undefined,
  open: (url: string) => void,
): void {
  clear(host)
  if (!activity || activity.error) {
    host.append(
      el(
        'p',
        { class: 'pr-activity-notice', role: 'status' },
        activity?.error ??
          'Comments and checks are unavailable. Refresh to retry or open on GitHub.',
      ),
    )
    return
  }
  if (section === 'comments') {
    host.append(
      el(
        'p',
        { class: 'pr-activity-notice' },
        'Conversation comments and submitted reviews. Inline code discussions are available on GitHub.',
      ),
    )
    if (activity.commentsTruncated)
      host.append(
        el(
          'p',
          { class: 'pr-activity-notice' },
          'Showing the latest 50 comments and 50 reviews. Open on GitHub for the full conversation.',
        ),
      )
    if (!activity.comments.length)
      host.append(el('p', {}, 'No conversation comments or submitted reviews yet.'))
    for (const comment of activity.comments) {
      const date = new Date(comment.createdAt)
      const time = el(
        'time',
        { datetime: comment.createdAt },
        Number.isNaN(date.getTime()) ? comment.createdAt : date.toLocaleString(),
      )
      const heading = el(
        'div',
        { class: 'pr-comment-meta' },
        el('strong', {}, `@${comment.author}`),
        el('span', {}, comment.reviewState ? readableState(comment.reviewState) : 'commented'),
        time,
      )
      const body = el('div', { class: 'message-text streaming-markdown pr-comment-body' })
      body.innerHTML = renderMarkdown(comment.body)
      host.append(
        el('article', { class: 'pr-comment', 'data-comment-id': comment.id }, heading, body),
      )
    }
    return
  }
  host.append(
    el(
      'p',
      { class: 'pr-activity-notice' },
      `Checks for head commit ${activity.headSha.slice(0, 7)}`,
    ),
  )
  if (activity.checksTruncated)
    host.append(
      el(
        'p',
        { class: 'pr-activity-notice' },
        'Showing the first 100 checks. Open on GitHub for all results.',
      ),
    )
  if (!activity.checks.length) host.append(el('p', {}, 'No checks reported for this commit.'))
  for (const check of activity.checks) {
    host.append(
      el(
        'div',
        { class: 'pr-check-row' },
        el(
          'span',
          { class: `pr-check-state pr-check-state-${checkTone(check.state)}` },
          readableState(check.state),
        ),
        el('span', { class: 'pr-check-name' }, check.name),
        externalButton('Details', check.url, open),
      ),
    )
  }
}
