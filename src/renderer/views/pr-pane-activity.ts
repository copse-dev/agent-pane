import type {
  GhPrActivity,
  GhPrCheck,
  GhPrComment,
  GhPrReviewThread,
  PrActionResult,
} from '@shared/types/git.ts'
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
import { reviewThreadLocation } from './pr-pane-thread.ts'

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

function renderComment(comment: GhPrComment): HTMLElement {
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
  return el('article', { class: 'pr-comment', 'data-comment-id': comment.id }, heading, body)
}

/** What the Comments view can do with inline review threads; each is optional. */
export interface ReviewThreadActions {
  /** Hand threads to the agent. */
  address?: (threads: GhPrReviewThread[]) => void
  /** Post a reply. */
  reply?: (thread: GhPrReviewThread, body: string) => Promise<PrActionResult>
  /** Resolve or reopen. */
  setResolved?: (thread: GhPrReviewThread, resolved: boolean) => Promise<PrActionResult>
  /** Reload the view after a successful write, once its draft is settled. */
  refresh?: () => void
  /** Unsent replies by thread id, kept by the caller across re-renders and failures. */
  drafts?: Map<string, string>
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

/**
 * Reply box and Resolve/Reopen for one thread. Controls stay disabled while a
 * write is in flight so a double click cannot post twice; a failure keeps the
 * typed reply and says why.
 */
function renderThreadControls(
  thread: GhPrReviewThread,
  actions: ReviewThreadActions,
): HTMLElement | null {
  const { reply, setResolved, drafts } = actions
  if (!reply && !setResolved) return null
  const location = reviewThreadLocation(thread)
  const footer = el('div', { class: 'pr-review-thread-footer' })
  const status = el('p', { class: 'pr-review-thread-status', role: 'status', hidden: true })
  const buttons: HTMLButtonElement[] = []
  let input: HTMLTextAreaElement | null = null
  let replyButton: HTMLButtonElement | null = null
  const setBusy = (busy: boolean): void => {
    for (const button of buttons) button.disabled = busy
    if (input) input.disabled = busy
    if (!busy && replyButton && input) replyButton.disabled = !input.value.trim()
  }
  const run = async (work: () => Promise<PrActionResult>, pending: string): Promise<void> => {
    setBusy(true)
    status.hidden = false
    status.removeAttribute('data-ok')
    status.textContent = pending
    let result: { ok: boolean; message: string }
    try {
      result = await work()
    } catch (error) {
      result = { ok: false, message: failureMessage(error) }
    }
    // On success the caller re-renders with fresh data; leave this view busy
    // until then so nothing can be sent twice.
    if (result.ok) {
      status.textContent = result.message
      status.setAttribute('data-ok', 'true')
      actions.refresh?.()
      return
    }
    status.textContent = result.message
    status.setAttribute('data-ok', 'false')
    setBusy(false)
  }
  if (reply && !thread.isResolved) {
    const box = el('textarea', {
      class: 'pr-review-reply-input',
      rows: '2',
      placeholder: 'Reply…',
      'aria-label': `Reply to review comment on ${location}`,
    })
    box.value = drafts?.get(thread.id) ?? ''
    input = box
    const send = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact pr-review-reply-btn' },
      'Reply',
    )
    send.disabled = !box.value.trim()
    replyButton = send
    buttons.push(send)
    const submit = (): void => {
      const body = box.value.trim()
      if (!body || send.disabled) return
      void run(async () => {
        const result = await reply(thread, body)
        if (result.ok) drafts?.delete(thread.id)
        return result
      }, 'Posting reply…')
    }
    box.addEventListener('input', () => {
      if (box.value) drafts?.set(thread.id, box.value)
      else drafts?.delete(thread.id)
      send.disabled = !box.value.trim()
    })
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        submit()
      }
    })
    send.addEventListener('click', submit)
    footer.append(box)
  }
  const row = el('div', { class: 'pr-review-thread-actions' })
  if (replyButton) row.append(replyButton)
  if (setResolved) {
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-secondary ui-btn-compact pr-review-resolve-btn',
        'aria-label': `${thread.isResolved ? 'Reopen' : 'Resolve'} review comment on ${location}`,
      },
      thread.isResolved ? 'Reopen' : 'Resolve',
    )
    buttons.push(toggle)
    toggle.addEventListener('click', () => {
      void run(
        () => setResolved(thread, !thread.isResolved),
        thread.isResolved ? 'Reopening…' : 'Resolving…',
      )
    })
    row.append(toggle)
  }
  footer.append(row, status)
  return footer
}

function renderReviewThread(
  thread: GhPrReviewThread,
  open: (url: string) => void,
  actions: ReviewThreadActions,
): HTMLElement {
  const location = reviewThreadLocation(thread)
  const header = el(
    'div',
    { class: 'pr-review-thread-header' },
    el('code', { class: 'pr-review-thread-path', title: thread.path }, location),
  )
  if (thread.isOutdated) header.append(el('span', { class: 'pr-review-state' }, 'outdated'))
  const { address } = actions
  if (!thread.isResolved && address) {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'pr-activity-link pr-review-thread-address',
        'aria-label': `Address review comment on ${location}`,
      },
      'Address',
    )
    button.addEventListener('click', () => {
      address([thread])
    })
    header.append(button)
  }
  const article = el(
    'article',
    { class: 'pr-review-thread', 'data-thread-id': thread.id },
    header,
    ...thread.comments.map((comment) => renderComment(comment)),
  )
  const last = thread.comments.at(-1)
  if (thread.commentsTruncated && last)
    article.append(
      el(
        'p',
        { class: 'pr-activity-notice pr-review-thread-more' },
        externalButton('More replies on GitHub', last.url, open),
      ),
    )
  const controls = renderThreadControls(thread, actions)
  if (controls) article.append(controls)
  return article
}

/**
 * Inline code discussions, unresolved first. Unresolved threads can be handed
 * to the agent, replied to and resolved; resolved ones stay collapsed and can
 * be reopened.
 */
function renderReviewThreads(
  host: HTMLElement,
  activity: GhPrActivity,
  open: (url: string) => void,
  actions: ReviewThreadActions,
): void {
  const unresolved = activity.reviewThreads.filter((thread) => !thread.isResolved)
  const resolved = activity.reviewThreads.filter((thread) => thread.isResolved)
  const heading = el(
    'h4',
    { class: 'pr-check-group-heading' },
    el('span', {}, 'Code discussions'),
    el('span', { class: 'pr-check-count' }, `${String(unresolved.length)} unresolved`),
  )
  const { address } = actions
  if (unresolved.length > 1 && address) {
    const addressAll = el(
      'button',
      { type: 'button', class: 'pr-activity-link pr-review-thread-address-all' },
      `Address all ${String(unresolved.length)}`,
    )
    addressAll.addEventListener('click', () => {
      address(unresolved)
    })
    heading.append(addressAll)
  }
  const section = el('section', { class: 'pr-check-group pr-review-threads' }, heading)
  if (activity.reviewThreadsTruncated)
    section.append(
      el(
        'p',
        { class: 'pr-activity-notice' },
        'Showing the first 100 code discussions. Open on GitHub for the rest.',
      ),
    )
  if (!activity.reviewThreads.length)
    section.append(el('p', { class: 'pr-activity-notice' }, 'No inline code discussions.'))
  for (const thread of unresolved) section.append(renderReviewThread(thread, open, actions))
  if (resolved.length) {
    const details = el(
      'details',
      { class: 'pr-check-group pr-review-threads-resolved' },
      el(
        'summary',
        { class: 'pr-check-group-heading' },
        chevronRightIcon('ui-icon ui-icon-sm pr-check-chevron'),
        el('span', {}, 'Resolved'),
        el('span', { class: 'pr-check-count' }, String(resolved.length)),
      ),
    )
    // Resolved threads offer only Reopen: no reply box and no Address.
    const reopenOnly: ReviewThreadActions = actions.setResolved
      ? {
          setResolved: actions.setResolved,
          ...(actions.refresh ? { refresh: actions.refresh } : {}),
        }
      : {}
    for (const thread of resolved) details.append(renderReviewThread(thread, open, reopenOnly))
    section.append(details)
  }
  host.append(section)
}

export function renderPrActivity(
  host: HTMLElement,
  section: 'comments' | 'checks',
  activity: GhPrActivity | undefined,
  open: (url: string) => void,
  fixCheck?: (check: GhPrCheck, headSha: string) => void,
  threadActions: ReviewThreadActions = {},
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
    renderReviewThreads(host, activity, open, threadActions)
    host.append(
      el('h4', { class: 'pr-check-group-heading pr-conversation-heading' }, 'Conversation'),
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
    for (const comment of activity.comments) host.append(renderComment(comment))
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
      const fixButton =
        group.tone === 'failure' && fixCheck
          ? el(
              'button',
              {
                type: 'button',
                class: 'pr-activity-link pr-check-fix-btn',
                'aria-label': `Fix ${check.name}`,
              },
              'Fix',
            )
          : null
      fixButton?.addEventListener('click', () => fixCheck?.(check, activity.headSha))
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
          ...(fixButton ? [fixButton] : []),
          externalButton('Details', check.url, open),
        ),
      )
    }
    host.append(section)
  }
}
