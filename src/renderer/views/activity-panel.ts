import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import {
  checkIcon,
  closeIcon,
  handIcon,
  messageQuestionIcon,
  runningStatusIcon,
  warningIcon,
} from '../dom/icons.ts'
import { switchProjectThread } from '../controller/projects.ts'
import {
  collectActivityThreads,
  deriveActivity,
  formatAge,
  formatAgeLong,
  trackRunTimings,
  type ActivityGroup,
  type ActivityRow,
  type ActivityRowState,
} from '../controller/activity-model.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { APPROVAL_SETTLE_MS, type ApprovalRequests, type ApprovalTimer } from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'

/**
 * The Activity panel (docs/plans/mission-control.md, slice 1): one overlay,
 * reachable from anywhere, listing every thread the app has loaded by its claim
 * on the user's attention — Needs you, Working, Recently finished.
 *
 * It is a place work is *seen*, not a second place it happens. Opening a row
 * goes to the existing thread. The one thing answerable in place is an
 * approval, and that goes back through the approval dialog's own queue
 * ({@link ApprovalRequests.answerOnce}) so there is still exactly one path to
 * `approval.respond`. A question opens its thread, where the ask dialog
 * surfaces it as it always has.
 */

/** Minimum gap between re-renders: a burst of state changes reorders the list at most 4×/s. */
export const ACTIVITY_RENDER_INTERVAL_MS = 250
/** Ages are minutes-granular, so a slow tick keeps them honest while open. */
export const ACTIVITY_AGE_REFRESH_MS = 30_000

export interface ActivitySources {
  approvals: ApprovalRequests
  questions: AskUserRequests
}

/** Clock and timer seams, injected at the boundary so tests control time. */
export interface ActivityPanelDeps {
  now?: () => number
  setTimer?: ApprovalTimer
}

export interface ActivityPanel {
  open: () => void
  close: () => void
  isOpen: () => boolean
}

const STATE_SHORT: Record<ActivityRowState, string> = {
  'needs-approval': 'Approve',
  'needs-answer': 'Answer',
  working: 'Running',
  failed: 'Failed',
  finished: 'Done',
}

const STATE_LONG: Record<ActivityRowState, string> = {
  'needs-approval': 'Needs approval',
  'needs-answer': 'Needs an answer',
  working: 'Running',
  failed: 'Failed',
  finished: 'Finished',
}

const AGE_VERB: Record<ActivityRowState, string> = {
  'needs-approval': 'waiting',
  'needs-answer': 'waiting',
  working: 'started',
  failed: 'ended',
  finished: 'ended',
}

/** A distinct outline glyph per state — never colour alone; the text label rides beside it. */
function stateGlyph(state: ActivityRowState): SVGSVGElement {
  const className = 'ui-icon ui-icon-sm activity-glyph'
  switch (state) {
    case 'needs-approval':
      return handIcon(className)
    case 'needs-answer':
      return messageQuestionIcon(className)
    case 'working':
      return runningStatusIcon(`${className} activity-glyph-running`)
    case 'failed':
      return warningIcon(className)
    case 'finished':
      return checkIcon(className)
  }
}

let openActive: (() => void) | null = null

/** Open the mounted Activity panel (sidebar bell, command palette, shortcut). */
export function openActivityPanel(): void {
  openActive?.()
}

const defaultTimer: ApprovalTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return () => {
    clearTimeout(handle)
  }
}

export function mountActivityPanel(
  api: ApiClient,
  store: AppStore,
  sources: ActivitySources,
  deps: ActivityPanelDeps = {},
): ActivityPanel {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? defaultTimer
  const timings = trackRunTimings(store, now)

  const { dialog, open, close, isOpen } = createOverlayDialog({
    id: 'activity-panel',
    className: 'activity-panel-overlay',
  })
  dialog.setAttribute('aria-labelledby', 'activity-panel-title')
  dialog.setAttribute('aria-describedby', 'activity-panel-subtitle')

  const closeButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost activity-panel-close',
      'aria-label': 'Close activity',
    },
    closeIcon(),
  )
  closeButton.addEventListener('click', close)

  const body = el('div', { class: 'activity-panel-body' })
  const status = el('p', {
    class: 'activity-panel-status',
    role: 'status',
    'aria-live': 'polite',
  })
  dialog.append(
    el(
      'div',
      { class: 'activity-panel-shell' },
      el(
        'header',
        { class: 'activity-panel-header' },
        el(
          'div',
          {},
          el('h2', { id: 'activity-panel-title' }, 'Activity'),
          el(
            'p',
            { id: 'activity-panel-subtitle', class: 'activity-panel-subtitle' },
            'Threads in the projects open this session, most urgent first.',
          ),
        ),
        closeButton,
      ),
      body,
      status,
      el(
        'footer',
        { class: 'activity-panel-footer' },
        el('span', {}, '↑ ↓ move · Enter opens the thread · Esc closes'),
      ),
    ),
  )

  let renderScheduled = false
  let cancelRender: (() => void) | null = null
  let lastRenderAt = Number.NEGATIVE_INFINITY
  let cancelAgeTick: (() => void) | null = null
  // Needs-you order as last drawn: a change arms the settle guard below.
  let needsYouSignature: string | null = null
  let cancelSettle: (() => void) | null = null
  let settling = false

  function canOpen(row: ActivityRow): boolean {
    if (!row.threadId || !row.projectId) return false
    const { projectId } = row
    return store.getState().projects.some((project) => project.id === projectId)
  }

  function openThread(row: ActivityRow): void {
    if (!row.threadId || !row.projectId || !canOpen(row)) return
    close()
    switchProjectThread(store, api, row.projectId, row.threadId)
  }

  function rowLabel(row: ActivityRow, ageLong: string | null): string {
    const want = row.detail ? `${row.want} — ${row.detail}` : row.want
    const parts = [
      `${STATE_LONG[row.state]}: ${want}`,
      row.projectName ? `${row.threadTitle}, ${row.projectName}` : row.threadTitle,
    ]
    if (ageLong) {
      const verb = AGE_VERB[row.state]
      parts.push(ageLong === 'just now' ? `${verb} just now` : `${verb} ${ageLong} ago`)
    }
    if (canOpen(row)) parts.push('Open thread')
    return parts.join('. ')
  }

  /**
   * Answer from the panel through the approval dialog's own queue. The row's
   * buttons go inert at once, so a second click cannot send a second answer;
   * `answerOnce` reports false when the request was already settled elsewhere.
   */
  function answerApproval(row: ActivityRow, approved: boolean, buttons: HTMLButtonElement[]): void {
    if (!row.requestId) return
    for (const button of buttons) {
      button.disabled = true
      button.dataset['answered'] = 'true'
    }
    const sent = sources.approvals.answerOnce(row.requestId, approved)
    status.textContent = !sent
      ? 'That request was already answered.'
      : approved
        ? `Approved once for ${row.threadTitle}.`
        : `Rejected for ${row.threadTitle}.`
    scheduleRender()
  }

  function actionsFor(row: ActivityRow): HTMLElement | null {
    if (row.state === 'needs-approval') {
      const approve = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-primary activity-approve',
          'data-control': 'approve',
          'aria-label': `Approve once: ${row.want} (${row.threadTitle})`,
        },
        'Approve once',
      )
      const reject = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary activity-reject',
          'data-control': 'reject',
          'aria-label': `Reject: ${row.want} (${row.threadTitle})`,
        },
        'Reject',
      )
      approve.disabled = settling
      approve.addEventListener('click', () => {
        // Honour the settle guard even for a synthetic/keyboard activation.
        if (approve.disabled) return
        answerApproval(row, true, [approve, reject])
      })
      reject.addEventListener('click', () => {
        if (reject.disabled) return
        answerApproval(row, false, [approve, reject])
      })
      return el('div', { class: 'activity-row-actions' }, approve, reject)
    }
    if (row.state === 'needs-answer') {
      const answer = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary activity-answer',
          'data-control': 'answer',
          'aria-label': `Answer in thread: ${row.threadTitle}`,
        },
        'Answer…',
      )
      if (row.threadId === null) {
        // A question tied to no run is already on screen behind this panel.
        answer.addEventListener('click', close)
      } else if (canOpen(row)) {
        answer.addEventListener('click', () => {
          openThread(row)
        })
      } else {
        answer.disabled = true
      }
      return el('div', { class: 'activity-row-actions' }, answer)
    }
    return null
  }

  function rowElement(row: ActivityRow, at: number): HTMLLIElement {
    const elapsed = row.since === null ? null : Math.max(0, at - row.since)
    const openable = canOpen(row)
    const want = el(
      'span',
      { class: 'activity-want' },
      el('span', { class: 'activity-want-text' }, row.want),
    )
    if (row.detail) {
      want.append(
        el(
          'span',
          {
            class:
              row.requestType === 'shell'
                ? 'activity-want-detail activity-want-code'
                : 'activity-want-detail',
          },
          row.detail,
        ),
      )
    }
    const openButton = el(
      'button',
      {
        type: 'button',
        class: 'activity-row-open',
        'data-control': 'open',
        tabindex: '-1',
        'aria-label': rowLabel(row, elapsed === null ? null : formatAgeLong(elapsed)),
        ...(openable ? {} : { 'aria-disabled': 'true' }),
      },
      stateGlyph(row.state),
      el('span', { class: 'activity-state' }, STATE_SHORT[row.state]),
      want,
      el('span', { class: 'activity-thread', title: row.threadTitle }, row.threadTitle),
      el('span', { class: 'activity-project' }, row.projectName ?? '—'),
      elapsed === null || row.since === null
        ? el('span', { class: 'activity-age' })
        : el(
            'time',
            { class: 'activity-age', datetime: new Date(row.since).toISOString() },
            formatAge(elapsed),
          ),
    )
    openButton.addEventListener('click', () => {
      openThread(row)
    })
    const item = el(
      'li',
      {
        class: 'activity-row',
        'data-row-key': row.key,
        'data-state': row.state,
        ...(row.threadId ? { 'data-thread-id': row.threadId } : {}),
        ...(row.requestId ? { 'data-request-id': row.requestId } : {}),
      },
      openButton,
    )
    item.append(actionsFor(row) ?? el('div', { class: 'activity-row-actions' }))
    return item
  }

  function groupElement(group: ActivityGroup, at: number): HTMLElement {
    const titleId = `activity-group-${group.id}`
    const hidden = group.total - group.rows.length
    const count =
      hidden > 0 ? `${String(group.rows.length)} of ${String(group.total)}` : String(group.total)
    return el(
      'section',
      { class: 'activity-group', 'data-group': group.id },
      el(
        'h4',
        { id: titleId, class: 'activity-group-title' },
        group.label,
        el('span', { class: 'activity-group-count' }, count),
      ),
      el(
        'ul',
        { class: 'activity-rows', role: 'list', 'aria-labelledby': titleId },
        ...group.rows.map((row) => rowElement(row, at)),
      ),
    )
  }

  function emptyState(): HTMLElement {
    return el(
      'div',
      { class: 'activity-empty' },
      el('p', { class: 'activity-empty-title' }, 'Nothing is running or waiting on you.'),
      el(
        'p',
        { class: 'activity-empty-body' },
        'When an agent stops for your approval or asks a question, it is listed here first, ' +
          'and you can answer an approval without leaving the thread you are in. Agents that ' +
          'are working come next, then runs that recently finished or failed.',
      ),
    )
  }

  interface FocusSpot {
    key: string
    control: string
    index: number
  }

  function rowOpeners(): HTMLButtonElement[] {
    return [...body.querySelectorAll<HTMLButtonElement>('.activity-row-open')]
  }

  function captureFocus(): FocusSpot | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !body.contains(active)) return null
    const row = active.closest<HTMLElement>('.activity-row')
    const key = row?.dataset['rowKey']
    if (!row || !key) return null
    const opener = row.querySelector<HTMLButtonElement>('.activity-row-open')
    return {
      key,
      control: active.dataset['control'] ?? 'open',
      index: opener ? rowOpeners().indexOf(opener) : 0,
    }
  }

  function setRovingTarget(target: HTMLButtonElement | undefined): void {
    for (const opener of rowOpeners()) opener.tabIndex = opener === target ? 0 : -1
  }

  function restoreFocus(spot: FocusSpot | null): void {
    const openers = rowOpeners()
    if (!spot) {
      setRovingTarget(openers[0])
      return
    }
    const row = [...body.querySelectorAll<HTMLElement>('.activity-row')].find(
      (candidate) => candidate.dataset['rowKey'] === spot.key,
    )
    const control = row?.querySelector<HTMLButtonElement>(`[data-control="${spot.control}"]`)
    const opener = row?.querySelector<HTMLButtonElement>('.activity-row-open')
    // The row that had focus went away (answered, finished): stay at its place
    // in the list rather than throwing focus back to the top of the dialog.
    const fallback = openers[Math.min(spot.index, openers.length - 1)]
    const target = control && !control.disabled ? control : (opener ?? fallback)
    setRovingTarget(opener ?? fallback)
    if (target) target.focus({ preventScroll: false })
    else closeButton.focus()
  }

  function armSettle(): void {
    cancelSettle?.()
    settling = true
    cancelSettle = setTimer(() => {
      cancelSettle = null
      settling = false
      for (const button of body.querySelectorAll<HTMLButtonElement>('.activity-approve')) {
        // A row already answered keeps its inert buttons.
        if (!button.dataset['answered']) button.disabled = false
      }
    }, APPROVAL_SETTLE_MS)
  }

  function render(): void {
    renderScheduled = false
    cancelRender = null
    const at = now()
    lastRenderAt = at
    const focus = captureFocus()
    const groups = deriveActivity({
      threads: collectActivityThreads(store),
      approvals: sources.approvals.pending(),
      questions: sources.questions.pending(),
      runs: timings.runs,
    })
    const needsYou = groups.find((group) => group.id === 'needs-you')
    const signature = needsYou?.rows.map((row) => row.key).join('\n') ?? ''
    // Rows moving under a pointer are how a click meant for one approval lands
    // on another. When the waiting list changes after the user has seen it,
    // Approve pauses exactly as the approval dialog's does after an append;
    // Reject stays live, since a mis-click there can only deny.
    if (needsYouSignature !== null && signature !== needsYouSignature) armSettle()
    needsYouSignature = signature

    const populated = groups.filter((group) => group.rows.length > 0)
    if (populated.length === 0) {
      body.replaceChildren(emptyState())
    } else {
      const children: HTMLElement[] = []
      if (!needsYou || needsYou.rows.length === 0) {
        children.push(el('p', { class: 'activity-quiet' }, 'Nothing needs you right now.'))
      }
      children.push(...populated.map((group) => groupElement(group, at)))
      body.replaceChildren(...children)
    }
    dialog.dataset['needsYou'] = String(needsYou?.total ?? 0)
    restoreFocus(focus)
  }

  function scheduleRender(): void {
    if (!isOpen() || renderScheduled) return
    renderScheduled = true
    const wait = Math.max(0, lastRenderAt + ACTIVITY_RENDER_INTERVAL_MS - now())
    // A synchronous timer (tests) runs render() before this assignment returns;
    // `renderScheduled` — not this handle — is what gates the next schedule.
    cancelRender = setTimer(render, wait)
  }

  function tickAges(): void {
    cancelAgeTick = setTimer(() => {
      cancelAgeTick = null
      if (!isOpen()) return
      scheduleRender()
      tickAges()
    }, ACTIVITY_AGE_REFRESH_MS)
  }

  function moveFocus(event: KeyboardEvent): void {
    const openers = rowOpeners()
    if (openers.length === 0) return
    const row = event.target instanceof Element ? event.target.closest('.activity-row') : null
    const current = row?.querySelector<HTMLButtonElement>('.activity-row-open')
    const index = current ? openers.indexOf(current) : -1
    let next: number
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : Math.min(openers.length - 1, index + 1)
        break
      case 'ArrowUp':
        next = index < 0 ? 0 : Math.max(0, index - 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = openers.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = openers[next]
    setRovingTarget(target)
    target?.focus()
  }
  body.addEventListener('keydown', moveFocus)

  const onChange = (): void => {
    scheduleRender()
  }
  sources.approvals.onChange(onChange)
  sources.questions.onChange(onChange)
  store.on('threads_changed', onChange)
  store.on('thread_status_changed', onChange)
  store.on('projects_changed', onChange)
  store.on('agent_activity', onChange)

  dialog.addEventListener('close', () => {
    cancelRender?.()
    cancelRender = null
    renderScheduled = false
    cancelAgeTick?.()
    cancelAgeTick = null
    cancelSettle?.()
    cancelSettle = null
    settling = false
    needsYouSignature = null
    status.textContent = ''
  })

  const panel: ActivityPanel = {
    open: () => {
      if (isOpen()) return
      open()
      // A fresh look: nothing has moved under the user yet, so Approve is live.
      needsYouSignature = null
      render()
      const first = rowOpeners()[0]
      if (first) first.focus()
      else closeButton.focus()
      tickAges()
    },
    close,
    isOpen,
  }
  openActive = panel.open
  return panel
}
