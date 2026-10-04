import type { GhPrActivity } from '@shared/types/git.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { clear, el } from '../dom/helpers.ts'
import {
  checkIcon,
  chevronRightIcon,
  closeIcon,
  externalLinkIcon,
  minusIcon,
  circleIcon,
} from '../dom/icons.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'

export type PrDetailSection = 'overview' | 'comments' | 'checks' | 'files'

function readableState(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ')
}

function checkTone(state: string): string {
  if (state === 'SUCCESS') return 'success'
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
  const button = el(
    'button',
    { type: 'button', class: 'pr-activity-link' },
    el('span', {}, label),
    externalLinkIcon('ui-icon ui-icon-sm'),
  )
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
        {
          datetime: comment.createdAt,
          title: Number.isNaN(date.getTime()) ? comment.createdAt : date.toLocaleString(),
        },
        Number.isNaN(date.getTime())
          ? comment.createdAt
          : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
      )
      const heading = el(
        'div',
        { class: 'pr-comment-meta' },
        el(
          'span',
          { class: 'pr-comment-avatar', 'aria-hidden': 'true' },
          comment.author.slice(0, 2).toUpperCase(),
        ),
        el(
          'div',
          { class: 'pr-comment-author' },
          el('strong', {}, `@${comment.author}`),
          el(
            'span',
            {
              class: comment.reviewState
                ? `pr-review-state pr-review-state-${comment.reviewState.toLowerCase()}`
                : 'pr-comment-kind',
            },
            comment.reviewState ? readableState(comment.reviewState) : 'commented',
          ),
        ),
        time,
      )
      const body = el('div', { class: 'message-text streaming-markdown pr-comment-body' })
      body.innerHTML = renderMarkdown(comment.body)
      attachCodeBlockCopyButtons(body)
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
  const groups = [
    { tone: 'failure', label: 'Needs attention' },
    { tone: 'pending', label: 'In progress' },
    { tone: 'success', label: 'Passed' },
    { tone: 'unknown', label: 'Other results' },
  ]
  const needsAttention = activity.checks.some((check) =>
    ['failure', 'pending'].includes(checkTone(check.state)),
  )
  for (const group of groups) {
    const checks = activity.checks.filter((check) => checkTone(check.state) === group.tone)
    if (!checks.length) continue
    const collapsible = group.tone === 'success' || group.tone === 'unknown'
    const section = collapsible
      ? el('details', {
          class: 'pr-check-group',
          open: group.tone === 'success' && !needsAttention,
        })
      : el('section', { class: 'pr-check-group' })
    section.append(
      el(
        collapsible ? 'summary' : 'h4',
        { class: 'pr-check-group-heading' },
        ...(collapsible ? [chevronRightIcon('ui-icon ui-icon-sm pr-check-chevron')] : []),
        el('span', {}, group.label),
        el('span', { class: 'pr-check-count' }, String(checks.length)),
      ),
    )
    for (const check of checks) {
      const icon =
        group.tone === 'success'
          ? checkIcon()
          : group.tone === 'failure'
            ? closeIcon()
            : group.tone === 'pending'
              ? circleIcon()
              : minusIcon()
      section.append(
        el(
          'div',
          { class: 'pr-check-row' },
          el('span', { class: `pr-check-icon pr-check-tone-${group.tone}` }, icon),
          el(
            'div',
            { class: 'pr-check-body' },
            el('span', { class: 'pr-check-name' }, check.name),
            el(
              'span',
              { class: `pr-check-state pr-check-state-${checkTone(check.state)}` },
              readableState(check.state),
            ),
          ),
          externalButton('Details', check.url, open),
        ),
      )
    }
    host.append(section)
  }
}
