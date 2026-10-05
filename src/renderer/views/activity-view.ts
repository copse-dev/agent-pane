import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { patchChildren } from '../dom/patch-children.ts'
import {
  arrowUpRightIcon,
  checkIcon,
  chevronDownIcon,
  messageQuestionIcon,
  runningStatusIcon,
  shieldIcon,
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
  type ActivityGroupId,
  type ActivityRow,
  type ActivityRowState,
} from '../controller/activity-model.ts'
import {
  APPROVAL_SETTLE_MS,
  approvalRequestDetails,
  type ApprovalRequests,
  type ApprovalTimer,
} from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'

/**
 * The Activity view (docs/plans/mission-control.md): every thread the app has
 * loaded, listed by its claim on the user's attention — Needs you, Working,
 * Recently finished — with a detail pane for the selected row.
 *
 * It knows nothing about where it is shown. A host (today the overlay in
 * `activity-panel.ts`) supplies the three things that depend on placement:
 * how to dismiss the view, whether it is on screen, and where focus goes when
 * no row is left to hold it. The view draws only while the host says it is
 * shown, so a hidden view costs nothing.
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
      return shieldIcon(className)
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

const defaultTimer: ApprovalTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return () => {
    clearTimeout(handle)
  }
}

/** What the view needs from wherever it is placed. */
export interface ActivityViewHost {
  /** Prefix for the element ids the view sets, so two hosts can mount it on one page. */
  idPrefix: string
  /** Leave the view (an overlay closes; a host with nothing to dismiss does nothing). */
  close: () => void
  /** Whether the view is on screen: updates and the age tick pause while it is not. */
  isShown: () => boolean
  /** Where focus lands when the row that held it is gone and no row is left. */
  fallbackFocus: () => void
  /** Called after each draw with the number of rows that need the user. */
  onNeedsYou?: (count: number) => void
  /**
   * Called after each draw with whether no thread anywhere has anything to list
   * (before any project filter). The screen uses it to step aside for the composer.
   */
  onIdle?: (idle: boolean) => void
  /** Group headers fold their rows (Working starts folded); the overlay keeps them static. */
  collapsibleGroups?: boolean
  /** Keep a per-project strip current and let it filter the list; the overlay has none. */
  projectStrip?: boolean
  /**
   * Until the user picks a row, selection follows the most urgent one, so a screen
   * left open shows what needs them when it arrives. The overlay is opened to look
   * once, so it keeps the row it opened on.
   */
  followUrgent?: boolean
  /** Draw an up-right arrow after "Open thread" (the screen does; the overlay does not). */
  openThreadArrow?: boolean
}

export interface ActivityView {
  /** The summary line, list and detail pane; the host places them. */
  summary: HTMLElement
  body: HTMLElement
  /** The project tiles above the list; kept current only when the host asks for the strip. */
  strip: HTMLElement
  /** A polite live region for the result of an in-place answer. */
  status: HTMLElement
  /** Start a fresh look: most urgent row selected, drawn, focused, ages ticking. */
  show: (options?: { focusFirstRow?: boolean }) => void
  /** Stop drawing and forget the selection. */
  hide: () => void
}

export function createActivityView(
  api: ApiClient,
  store: AppStore,
  sources: ActivitySources,
  deps: ActivityPanelDeps,
  host: ActivityViewHost,
): ActivityView {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? defaultTimer
  const timings = trackRunTimings(store, now)

  const summary = el('p', { id: `${host.idPrefix}-summary`, class: 'activity-panel-summary' })
  const list = el('nav', { class: 'activity-list', 'aria-label': 'Threads' })
  const detail = el('section', {
    class: 'activity-detail',
    'aria-labelledby': `${host.idPrefix}-detail-title`,
  })
  const body = el('div', { class: 'activity-panel-body' }, list, detail)
  const status = el('p', {
    class: 'activity-panel-status',
    role: 'status',
    'aria-live': 'polite',
  })

  // Rows and groups are kept by key and reused while what they show is
  // unchanged, so a redraw leaves hover, focus and an in-flight click on an
  // untouched row alone (a rebuild every 250 ms is how a click lands on nothing).
  const rowCache = new Map<string, { signature: string; node: HTMLLIElement }>()
  const groupCache = new Map<
    ActivityGroup['id'],
    { section: HTMLElement; count: HTMLElement; rows: HTMLElement }
  >()
  const quiet = el('p', { class: 'activity-quiet' }, 'Nothing needs you right now.')
  const strip = el('div', {
    class: 'activity-strip',
    role: 'group',
    'aria-label': 'Projects',
  })
  const stripCache = new Map<string | null, { signature: string; node: HTMLElement }>()
  // Session-only: folded groups and the project filter reset with the selection.
  const defaultCollapsed = (): Set<ActivityGroupId> =>
    new Set<ActivityGroupId>(host.collapsibleGroups ? ['working'] : [])
  let collapsed = defaultCollapsed()
  // Needs-you keys already shown: a new one unfolds the group, an old one does not
  // re-open what the user folded.
  const seenNeedsYou = new Set<string>()
  let projectFilter: string | null = null
  // The user has chosen a row (click or arrow key) since the view was shown.
  let userChose = false
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
    host.close()
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
    // An icon child also opts the button out of the kit's cap-trim, so only the
    // host that wants the arrow pays for it.
    if (host.openThreadArrow)
      node.append(arrowUpRightIcon('ui-icon ui-icon-sm activity-open-arrow'))
    node.disabled = !canOpen(row)
    return node
  }

  /**
   * What the selected row is about, in full. For an approval that is the
   * request exactly as the approval prompt shows it — full title, advice, the
   * whole body and the footer, rendered by the prompt's own
   * `approvalRequestDetails` — and this pane is the only place the Approve action
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
        'Approve',
        () => {
          answerApproval(row, true)
        },
        `Approve: ${title} (${row.threadTitle})`,
      )
      approve.disabled = settling
      actions.push(approve)
    } else if (row.state === 'needs-answer') {
      const answer = button('ui-btn-primary activity-answer', 'answer', 'Answer in thread', () => {
        // A question tied to no run is already on screen behind this panel.
        if (row.threadId === null) host.close()
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
        el(
          'h3',
          { id: `${host.idPrefix}-detail-title`, class: 'activity-detail-title' },
          row.threadTitle,
        ),
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

  /** Everything rowElement draws, so an equal signature means the same pixels. */
  function rowSignature(row: ActivityRow, at: number): string {
    const elapsed = row.since === null ? null : Math.max(0, at - row.since)
    return JSON.stringify([
      row.state,
      row.threadId,
      row.requestId,
      row.requestType,
      row.threadTitle,
      row.projectName,
      row.want,
      row.detail,
      row.since,
      row.key === selectedKey,
      elapsed === null ? null : formatAge(elapsed),
      rowLabel(row, at),
    ])
  }

  function cachedRow(row: ActivityRow, at: number): HTMLLIElement {
    const signature = rowSignature(row, at)
    const hit = rowCache.get(row.key)
    if (hit?.signature === signature) return hit.node
    const node = rowElement(row, at)
    rowCache.set(row.key, { signature, node })
    return node
  }

  function toggleGroup(id: ActivityGroupId): void {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    renderNow()
  }

  function groupElement(group: ActivityGroup, at: number): HTMLElement {
    const hidden = group.total - group.rows.length
    const count =
      hidden > 0 ? `${String(group.rows.length)} of ${String(group.total)}` : String(group.total)
    const folded = host.collapsibleGroups === true && collapsed.has(group.id)
    let entry = groupCache.get(group.id)
    if (!entry) {
      const titleId = `${host.idPrefix}-group-${group.id}`
      const countNode = el('span', { class: 'activity-group-count' }, count)
      const rowsNode = el('ul', {
        class: 'activity-rows',
        role: 'list',
        'aria-labelledby': titleId,
      })
      let heading: HTMLElement
      if (host.collapsibleGroups) {
        const toggle = el(
          'button',
          {
            type: 'button',
            class: 'activity-group-toggle',
            'data-group-toggle': group.id,
            'aria-expanded': 'true',
          },
          chevronDownIcon('ui-icon ui-icon-sm activity-group-chevron'),
          el('span', { class: 'activity-group-label' }, group.label),
          countNode,
        )
        toggle.addEventListener('click', () => {
          toggleGroup(group.id)
        })
        heading = el('h4', { id: titleId, class: 'activity-group-title' }, toggle)
      } else {
        heading = el('h4', { id: titleId, class: 'activity-group-title' }, group.label, countNode)
      }
      entry = {
        section: el(
          'section',
          { class: 'activity-group', 'data-group': group.id },
          heading,
          rowsNode,
        ),
        count: countNode,
        rows: rowsNode,
      }
      groupCache.set(group.id, entry)
    }
    if (entry.count.textContent !== count) entry.count.textContent = count
    if (host.collapsibleGroups) {
      // A folded group says how many rows it holds; an open one shows them.
      entry.count.hidden = !folded
      entry.section.dataset['collapsed'] = folded ? 'true' : 'false'
      entry.section
        .querySelector('.activity-group-toggle')
        ?.setAttribute('aria-expanded', folded ? 'false' : 'true')
    }
    entry.rows.hidden = folded
    patchChildren(entry.rows, folded ? [] : group.rows.map((row) => cachedRow(row, at)))
    return entry.section
  }

  /** Per-project counts for the strip, from the unfiltered groups. */
  function projectStats(
    groups: readonly ActivityGroup[],
  ): Map<string, { name: string; need: number; working: number }> {
    const stats = new Map<string, { name: string; need: number; working: number }>()
    for (const group of groups) {
      if (group.id === 'recent') continue
      for (const row of group.rows) {
        if (!row.projectId) continue
        const entry = stats.get(row.projectId) ?? {
          name: row.projectName ?? row.projectId,
          need: 0,
          working: 0,
        }
        if (group.id === 'needs-you') entry.need += 1
        else entry.working += 1
        stats.set(row.projectId, entry)
      }
    }
    return stats
  }

  function stripCard(id: string | null, name: string, need: number, working: number): HTMLElement {
    const selected = projectFilter === id
    const signature = JSON.stringify([name, need, working, selected])
    const hit = stripCache.get(id)
    if (hit?.signature === signature) return hit.node
    const stats = el('span', { class: 'activity-strip-stats' })
    stats.append(
      need > 0
        ? el('span', { class: 'activity-strip-need' }, `${String(need)} need you`)
        : el('span', {}, 'All clear'),
    )
    if (working > 0) stats.append(el('span', {}, `${String(working)} working`))
    const node = el(
      'button',
      {
        type: 'button',
        class: 'activity-strip-card',
        'data-project': id ?? 'all',
        'data-project-key': JSON.stringify(id),
        'aria-pressed': selected ? 'true' : 'false',
      },
      el('span', { class: 'activity-strip-name' }, name),
      stats,
    )
    node.addEventListener('click', () => {
      projectFilter = id
      renderNow()
    })
    stripCache.set(id, { signature, node })
    return node
  }

  /** All projects, then the ones that need you (most waiting first) and the chosen one. */
  function renderStrip(groups: readonly ActivityGroup[]): void {
    const stats = projectStats(groups)
    if (projectFilter !== null && !stats.has(projectFilter)) {
      const project = store.getState().projects.find((entry) => entry.id === projectFilter)
      if (project) stats.set(project.id, { name: project.name, need: 0, working: 0 })
    }
    // Aggregate counts include requests whose thread has no project association.
    const need = groups.find((group) => group.id === 'needs-you')?.total ?? 0
    const working = groups.find((group) => group.id === 'working')?.total ?? 0
    const cards = [stripCard(null, 'All projects', need, working)]
    const shown = [...stats.entries()]
      .filter(([id, entry]) => entry.need > 0 || id === projectFilter)
      .sort((a, b) => b[1].need - a[1].need || a[1].name.localeCompare(b[1].name))
    for (const [id, entry] of shown)
      cards.push(stripCard(id, entry.name, entry.need, entry.working))
    patchChildren(strip, cards)
    const live = new Set<string | null>([null, ...shown.map(([id]) => id)])
    for (const id of stripCache.keys()) {
      if (!live.has(id)) stripCache.delete(id)
    }
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

  /** Preserve what the reader is looking at while a live activity update redraws the list. */
  function captureListScrollAnchor(): { rowKey: string; viewportTop: number } | null {
    const listRect = list.getBoundingClientRect()
    for (const row of list.querySelectorAll<HTMLElement>('.activity-row')) {
      const rowKey = row.dataset['rowKey']
      if (!rowKey) continue
      const rowRect = row.getBoundingClientRect()
      if (rowRect.bottom > listRect.top) {
        return { rowKey, viewportTop: rowRect.top }
      }
    }
    return null
  }

  function restoreListScrollAnchor(
    anchor: { rowKey: string; viewportTop: number } | null,
    fallbackScrollTop: number,
  ): void {
    if (anchor) {
      const row = [...list.querySelectorAll<HTMLElement>('.activity-row')].find(
        (candidate) => candidate.dataset['rowKey'] === anchor.rowKey,
      )
      if (row) {
        const delta = row.getBoundingClientRect().top - anchor.viewportTop
        if (Math.abs(delta) > 0.5) list.scrollTop += delta
        return
      }
    }
    if (list.scrollTop !== fallbackScrollTop) list.scrollTop = fallbackScrollTop
  }

  /** Where focus was, so a re-render can put it back: the list, or a detail control. */
  function captureFocus():
    | { area: 'list' }
    | { area: 'toggle'; group: string }
    | { area: 'detail'; key: string; control: string }
    | { area: 'strip'; projectKey: string }
    | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    const toggled = active.dataset['groupToggle']
    if (toggled !== undefined) return { area: 'toggle', group: toggled }
    const projectKey = active.dataset['projectKey']
    if (projectKey !== undefined && strip.contains(active)) return { area: 'strip', projectKey }
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
    if (spot.area === 'toggle') {
      list.querySelector<HTMLElement>(`[data-group-toggle="${spot.group}"]`)?.focus({
        preventScroll: true,
      })
      return
    }
    if (spot.area === 'strip') {
      const card = [...strip.querySelectorAll<HTMLElement>('[data-project-key]')].find(
        (node) => node.dataset['projectKey'] === spot.projectKey,
      )
      card?.focus({ preventScroll: true })
      return
    }
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
    if (opener) opener.focus({ preventScroll: true })
    else host.fallbackFocus()
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
    const previousListScrollTop = list.scrollTop
    const listScrollAnchor = captureListScrollAnchor()
    const allThreads = collectActivityThreads(store)
    const approvals = sources.approvals.pending()
    const questions = sources.questions.pending()
    const everything = deriveActivity({
      threads: allThreads,
      approvals,
      questions,
      runs: timings.runs,
    })
    let groups = everything
    if (projectFilter !== null) {
      // Filter the inputs, not the groups: the Recently finished cap then counts
      // the chosen project's runs, not everyone's. Requests with no thread belong
      // to no project and only show under All projects.
      const inProject = allThreads.filter((thread) => thread.projectId === projectFilter)
      const ids = new Set(inProject.map((thread) => thread.id))
      groups = deriveActivity({
        threads: inProject,
        approvals: approvals.filter((req) => req.threadId !== undefined && ids.has(req.threadId)),
        questions: questions.filter((req) => req.threadId !== undefined && ids.has(req.threadId)),
        runs: timings.runs,
      })
    }
    if (host.projectStrip) renderStrip(everything)
    const needsYou = groups.find((group) => group.id === 'needs-you')
    // A request that is new to this view unfolds Needs you; one the user already
    // saw and folded stays folded.
    const currentNeeds = new Set(needsYou?.rows.map((row) => row.key))
    for (const key of currentNeeds) {
      if (!seenNeedsYou.has(key)) {
        seenNeedsYou.add(key)
        collapsed.delete('needs-you')
      }
    }
    for (const key of seenNeedsYou) {
      if (!currentNeeds.has(key)) seenNeedsYou.delete(key)
    }
    const working = groups.find((group) => group.id === 'working')
    const signature = needsYou?.rows.map((row) => row.key).join('\n') ?? ''
    // Rows moving under a pointer are how a click meant for one approval lands
    // on another. When the waiting list changes after the user has seen it,
    // Approve pauses exactly as the approval dialog's does after an append;
    // Reject stays live, since a mis-click there can only deny.
    const listChanged = needsYouSignature !== null && signature !== needsYouSignature
    needsYouSignature = signature

    // Folded groups hold no selectable row: selection moves to the nearest visible one.
    const rows = groups
      .filter((group) => !(host.collapsibleGroups && collapsed.has(group.id)))
      .flatMap((group) => group.rows)
    const urgent = rows[0]
    if (host.followUrgent && !userChose && urgent) selectedKey = urgent.key
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
    const populatedIds = new Set(populated.map((group) => group.id))
    for (const [groupId, entry] of groupCache) {
      if (!populatedIds.has(groupId)) entry.rows.replaceChildren()
    }
    if (populated.length === 0) {
      list.hidden = true
      list.replaceChildren()
      rowCache.clear()
      body.dataset['empty'] = 'true'
      detail.hidden = false
      detail.replaceChildren(emptyState())
      delete detail.dataset['rowKey']
      delete detail.dataset['state']
    } else {
      list.hidden = false
      delete body.dataset['empty']
      const children: HTMLElement[] = []
      if (!needsYou || needsYou.rows.length === 0) children.push(quiet)
      children.push(...populated.map((group) => groupElement(group, at)))
      patchChildren(list, children)
      const live = new Set(rows.map((row) => row.key))
      for (const rowKey of rowCache.keys()) {
        if (!live.has(rowKey)) rowCache.delete(rowKey)
      }
      restoreListScrollAnchor(listScrollAnchor, previousListScrollTop)
      renderDetail(selected, at)
    }
    host.onNeedsYou?.(needCount)
    host.onIdle?.(everything.every((group) => group.rows.length === 0))
    restoreFocus(focus)
  }

  /** Show a row in the detail pane (a click, or the arrow keys). */
  function select(rowKey: string): void {
    userChose = true
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
    if (!host.isShown() || renderScheduled) return
    renderScheduled = true
    const wait = Math.max(0, lastRenderAt + ACTIVITY_RENDER_INTERVAL_MS - now())
    // A synchronous timer (tests) runs render() before this assignment returns;
    // `renderScheduled` — not this handle — is what gates the next schedule.
    cancelRender = setTimer(render, wait)
  }

  function tickAges(): void {
    cancelAgeTick = setTimer(() => {
      cancelAgeTick = null
      if (!host.isShown()) return
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

  function hide(): void {
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
    for (const entry of groupCache.values()) entry.rows.replaceChildren()
    rowCache.clear()
    stripCache.clear()
    collapsed = defaultCollapsed()
    seenNeedsYou.clear()
    projectFilter = null
    userChose = false
  }

  function show({ focusFirstRow = true }: { focusFirstRow?: boolean } = {}): void {
    // A fresh look starts on the most urgent row. If that is an approval, its
    // request has not been read yet: render() arms the settle window, so
    // nothing is approvable until it has been on screen.
    needsYouSignature = null
    selectedKey = null
    selectedIndex = 0
    shownKey = null
    userChose = false
    render()
    // A host whose focus already belongs elsewhere (the composer on the new-thread
    // screen) asks for none: the view then only draws.
    if (focusFirstRow) {
      const first = selectedOpener()
      if (first) first.focus()
      else host.fallbackFocus()
    }
    tickAges()
  }

  return { summary, body, strip, status, show, hide }
}
