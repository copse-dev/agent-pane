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
import {
  APPROVAL_SETTLE_MS,
  approvalRequestDetails,
  type ApprovalRequests,
  type ApprovalTimer,
} from './approval-dialog.ts'
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

/** The word beside each row's glyph: state is never carried by colour alone. */
const STATE_SHORT: Record<ActivityRowState, string> = {
  'needs-approval': 'Approval',
  'needs-answer': 'Question',
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
  dialog.setAttribute('aria-describedby', 'activity-panel-summary')

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

  const summary = el('p', { id: 'activity-panel-summary', class: 'activity-panel-summary' })
  const list = el('nav', { class: 'activity-list', 'aria-label': 'Threads' })
  const detail = el('section', {
    class: 'activity-detail',
    'aria-labelledby': 'activity-detail-title',
  })
  const body = el('div', { class: 'activity-panel-body' }, list, detail)
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
        el('h2', { id: 'activity-panel-title' }, 'Activity'),
        summary,
        closeButton,
      ),
      body,
      el(
        'footer',
        { class: 'activity-panel-footer' },
        el('span', {}, '↑ ↓ choose · Tab to act · Esc closes'),
        status,
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
  // The row whose request or state the detail pane shows, and its place in the
  // list, so a row that leaves (answered, finished) hands selection to the next.
  let selectedKey: string | null = null
  let selectedIndex = 0
  // The row the detail pane last drew: a different one there has not been read.
  let shownKey: string | null = null

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

  function ageText(row: ActivityRow, at: number): string | null {
    if (row.since === null) return null
    const long = formatAgeLong(Math.max(0, at - row.since))
    const verb = AGE_VERB[row.state]
    return long === 'just now' ? `${verb} just now` : `${verb} ${long} ago`
  }

  function rowLabel(row: ActivityRow, at: number): string {
    const want = row.detail ? `${row.want} — ${row.detail}` : row.want
    const parts = [
      `${STATE_LONG[row.state]}: ${want}`,
      row.projectName ? `${row.threadTitle}, ${row.projectName}` : row.threadTitle,
    ]
    const age = ageText(row, at)
    if (age) parts.push(age)
    return parts.join('. ')
  }

  /**
   * Answer from the panel through the approval dialog's own queue. The detail's
   * buttons go inert at once, so a second click cannot send a second answer;
   * `answerOnce` reports false when the request was already settled elsewhere.
   */
  function answerApproval(row: ActivityRow, approved: boolean): void {
    if (!row.requestId) return
    for (const button of detail.querySelectorAll<HTMLButtonElement>(
      '.activity-approve, .activity-reject',
    )) {
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

  function button(
    className: string,
    control: string,
    label: string,
    onClick: () => void,
    ariaLabel?: string,
  ): HTMLButtonElement {
    const node = el(
      'button',
      {
        type: 'button',
        class: `ui-btn ${className}`,
        'data-control': control,
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      },
      label,
    )
    node.addEventListener('click', () => {
      // Honour a disabled state even for a synthetic/keyboard activation.
      if (!node.disabled) onClick()
    })
    return node
  }

  function openThreadButton(row: ActivityRow): HTMLButtonElement {
    const node = button('ui-btn-ghost activity-open-thread', 'open-thread', 'Open thread', () => {
      openThread(row)
    })
    node.disabled = !canOpen(row)
    return node
  }

  /**
   * What the selected row is about, in full. For an approval that is the
   * request exactly as the approval prompt shows it — full title, advice, the
   * whole body and the footer, rendered by the prompt's own
   * `approvalRequestDetails` — and this pane is the only place Approve once
   * exists, so a request is never approved from a view that shows less.
   */
  function detailContent(row: ActivityRow): HTMLElement[] {
    if (row.state === 'needs-approval' && row.approval) {
      const request = row.approval
      return [
        el(
          'div',
          {
            class: 'activity-review',
            role: 'region',
            'aria-label': `Approval request: ${request.title}`,
          },
          el('p', { class: 'activity-review-title' }, request.title),
          ...approvalRequestDetails(request),
        ),
      ]
    }
    if (row.state === 'needs-answer') {
      const asked = sources.questions.pending().find((request) => request.id === row.requestId)
      const questions = asked?.questions ?? [row.want]
      return [
        el(
          'ol',
          { class: 'activity-questions' },
          ...questions.map((question) => el('li', {}, question)),
        ),
        el(
          'p',
          { class: 'activity-detail-note' },
          'Answer in the thread, where the question is waiting for you.',
        ),
      ]
    }
    if (row.state === 'working') {
      return [
        el('p', { class: 'activity-detail-label' }, 'Latest activity'),
        el('p', { class: 'activity-detail-text' }, row.want),
      ]
    }
    return [el('p', { class: 'activity-detail-text' }, row.want)]
  }

  function detailActions(row: ActivityRow): HTMLElement {
    const actions: HTMLElement[] = [openThreadButton(row), el('span', { class: 'activity-spacer' })]
    if (row.state === 'needs-approval' && row.approval) {
      const title = row.approval.title
      actions.push(
        button(
          'ui-btn-secondary activity-reject',
          'reject',
          'Reject',
          () => {
            answerApproval(row, false)
          },
          `Reject: ${title} (${row.threadTitle})`,
        ),
      )
      const approve = button(
        'ui-btn-primary activity-approve',
        'approve',
        'Approve once',
        () => {
          answerApproval(row, true)
        },
        `Approve once: ${title} (${row.threadTitle})`,
      )
      approve.disabled = settling
      actions.push(approve)
    } else if (row.state === 'needs-answer') {
      const answer = button('ui-btn-primary activity-answer', 'answer', 'Answer in thread', () => {
        // A question tied to no run is already on screen behind this panel.
        if (row.threadId === null) close()
        else openThread(row)
      })
      answer.disabled = row.threadId !== null && !canOpen(row)
      actions.push(answer)
    }
    return el('div', { class: 'activity-detail-actions' }, ...actions)
  }

  function renderDetail(row: ActivityRow | undefined, at: number): void {
    if (!row) {
      detail.replaceChildren()
      detail.hidden = true
      return
    }
    detail.hidden = false
    detail.dataset['rowKey'] = row.key
    detail.dataset['state'] = row.state
    const meta = [row.projectName, ageText(row, at)].filter((part) => part !== null).join(' · ')
    detail.replaceChildren(
      el(
        'header',
        { class: 'activity-detail-header' },
        el(
          'p',
          { class: 'activity-detail-meta' },
          el('span', { class: 'activity-detail-state' }, STATE_LONG[row.state]),
          meta,
        ),
        el('h3', { id: 'activity-detail-title', class: 'activity-detail-title' }, row.threadTitle),
      ),
      el('div', { class: 'activity-detail-body' }, ...detailContent(row)),
      detailActions(row),
    )
  }

  function rowElement(row: ActivityRow, at: number): HTMLLIElement {
    const elapsed = row.since === null ? null : Math.max(0, at - row.since)
    const selected = row.key === selectedKey
    const second = el(
      'span',
      { class: 'activity-row-second' },
      el('span', { class: 'activity-state' }, STATE_SHORT[row.state]),
    )
    if (row.state !== 'failed' && row.state !== 'finished') {
      second.append(
        el(
          'span',
          {
            class:
              row.requestType === 'shell' && row.detail
                ? 'activity-want-text activity-want-code'
                : 'activity-want-text',
          },
          row.requestType === 'shell' && row.detail ? row.detail : row.want,
        ),
      )
    }
    const opener = el(
      'button',
      {
        type: 'button',
        class: 'activity-row-open',
        'data-control': 'open',
        tabindex: selected ? '0' : '-1',
        'aria-label': rowLabel(row, at),
        ...(selected ? { 'aria-current': 'true' } : {}),
      },
      stateGlyph(row.state),
      el('span', { class: 'activity-thread', title: row.threadTitle }, row.threadTitle),
      elapsed === null || row.since === null
        ? el('span', { class: 'activity-age' })
        : el(
            'time',
            { class: 'activity-age', datetime: new Date(row.since).toISOString() },
            formatAge(elapsed),
          ),
      second,
      el('span', { class: 'activity-project' }, row.projectName ?? ''),
    )
    opener.addEventListener('click', () => {
      select(row.key)
    })
    return el(
      'li',
      {
        class: 'activity-row',
        'data-row-key': row.key,
        'data-state': row.state,
        ...(selected ? { 'data-selected': 'true' } : {}),
        ...(row.threadId ? { 'data-thread-id': row.threadId } : {}),
        ...(row.requestId ? { 'data-request-id': row.requestId } : {}),
      },
      opener,
    )
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

  function rowOpeners(): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>('.activity-row-open')]
  }

  function selectedOpener(): HTMLButtonElement | undefined {
    return rowOpeners().find((opener) => opener.getAttribute('aria-current') === 'true')
  }

  /** Where focus was, so a re-render can put it back: the list, or a detail control. */
  function captureFocus():
    | { area: 'list' }
    | { area: 'detail'; key: string; control: string }
    | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    if (list.contains(active)) return { area: 'list' }
    if (detail.contains(active)) {
      return {
        area: 'detail',
        key: detail.dataset['rowKey'] ?? '',
        control: active.dataset['control'] ?? '',
      }
    }
    return null
  }

  function restoreFocus(spot: ReturnType<typeof captureFocus>): void {
    if (!spot) return
    if (spot.area === 'detail' && spot.key === selectedKey) {
      const control = detail.querySelector<HTMLButtonElement>(`[data-control="${spot.control}"]`)
      if (control && !control.disabled) {
        control.focus()
        return
      }
    }
    // The row that had focus went away (answered, finished): stay at its place
    // in the list rather than throwing focus back to the top of the dialog.
    const opener = selectedOpener()
    if (opener) opener.focus()
    else closeButton.focus()
  }

  function armSettle(): void {
    cancelSettle?.()
    settling = true
    for (const approve of detail.querySelectorAll<HTMLButtonElement>('.activity-approve')) {
      approve.disabled = true
    }
    cancelSettle = setTimer(() => {
      cancelSettle = null
      settling = false
      for (const approve of detail.querySelectorAll<HTMLButtonElement>('.activity-approve')) {
        // A request already answered keeps its inert buttons.
        if (!approve.dataset['answered']) approve.disabled = false
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
    const working = groups.find((group) => group.id === 'working')
    const signature = needsYou?.rows.map((row) => row.key).join('\n') ?? ''
    // Rows moving under a pointer are how a click meant for one approval lands
    // on another. When the waiting list changes after the user has seen it,
    // Approve pauses exactly as the approval dialog's does after an append;
    // Reject stays live, since a mis-click there can only deny.
    const listChanged = needsYouSignature !== null && signature !== needsYouSignature
    needsYouSignature = signature

    const rows = groups.flatMap((group) => group.rows)
    let selected = rows.find((row) => row.key === selectedKey)
    if (!selected) {
      selected = rows[Math.min(selectedIndex, rows.length - 1)]
      selectedKey = selected?.key ?? null
    }
    selectedIndex = selected ? rows.indexOf(selected) : 0
    // A different request in the detail pane has not been read yet.
    if (listChanged || (selectedKey !== shownKey && selected?.state === 'needs-approval')) {
      armSettle()
    }
    shownKey = selectedKey

    const needCount = needsYou?.total ?? 0
    const workCount = working?.total ?? 0
    summary.textContent =
      needCount === 0 && workCount === 0
        ? 'Threads in the projects open this session, most urgent first.'
        : `${needCount === 0 ? 'Nothing needs' : `${String(needCount)} ${needCount === 1 ? 'needs' : 'need'}`} you · ${String(workCount)} working`

    const populated = groups.filter((group) => group.rows.length > 0)
    if (populated.length === 0) {
      list.hidden = true
      list.replaceChildren()
      body.dataset['empty'] = 'true'
      detail.hidden = false
      detail.replaceChildren(emptyState())
      delete detail.dataset['rowKey']
      delete detail.dataset['state']
    } else {
      list.hidden = false
      delete body.dataset['empty']
      const children: HTMLElement[] = []
      if (!needsYou || needsYou.rows.length === 0) {
        children.push(el('p', { class: 'activity-quiet' }, 'Nothing needs you right now.'))
      }
      children.push(...populated.map((group) => groupElement(group, at)))
      list.replaceChildren(...children)
      renderDetail(selected, at)
    }
    dialog.dataset['needsYou'] = String(needCount)
    restoreFocus(focus)
  }

  /** Show a row in the detail pane (a click, or the arrow keys). */
  function select(rowKey: string): void {
    if (rowKey !== selectedKey) {
      selectedKey = rowKey
      renderNow()
    }
    selectedOpener()?.focus()
  }

  /** Redraw at once, for the user's own action. */
  function renderNow(): void {
    cancelRender?.()
    render()
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

  function moveSelection(event: KeyboardEvent): void {
    const openers = rowOpeners()
    if (openers.length === 0) return
    const current = event.target instanceof Element ? event.target.closest('.activity-row') : null
    const opener = current?.querySelector<HTMLButtonElement>('.activity-row-open')
    const index = opener ? openers.indexOf(opener) : -1
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
    const target = openers[next]?.closest<HTMLElement>('.activity-row')?.dataset['rowKey']
    if (target) select(target)
  }
  list.addEventListener('keydown', moveSelection)

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
    selectedKey = null
    selectedIndex = 0
    shownKey = null
    status.textContent = ''
  })

  const panel: ActivityPanel = {
    open: () => {
      if (isOpen()) return
      open()
      // A fresh look starts on the most urgent row. If that is an approval, its
      // request has not been read yet: render() arms the settle window, so
      // nothing is approvable until it has been on screen.
      needsYouSignature = null
      selectedKey = null
      selectedIndex = 0
      shownKey = null
      render()
      const first = selectedOpener()
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
