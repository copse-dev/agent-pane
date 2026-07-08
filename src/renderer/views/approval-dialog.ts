import { el, qsRequired } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isSettingsDialogOpen, onSettingsDialogClose } from './settings-dialog.ts'
import { setAttentionThreads } from '../controller/attention.ts'

/**
 * How long the first pending request waits before the dialog pops, so a burst of
 * concurrent `session/request_permission` calls (an agent running several tool
 * calls in parallel) coalesces into one prompt instead of a modal per command.
 * Kept well under 200ms so the first prompt still feels instant; requests that
 * arrive after the dialog is already open are appended live, so this window only
 * needs to catch the initial burst.
 */
export const APPROVAL_COALESCE_MS = 120

/**
 * How long Approve is disabled after a request is appended to an *already open*
 * prompt. Live-appending means a command could land in the batch in the same
 * instant the user commits a click on Approve — approving something they never
 * read (a clickjack-style race). Pausing Approve until the list has been settled
 * for this long forces a fresh, deliberate click on the changed batch. Longer
 * than the coalesce window because it has to outlast an already-in-flight click,
 * not just gather a burst. Reject stays live throughout: a mis-click during the
 * churn can only ever deny, never approve something unseen.
 */
export const APPROVAL_SETTLE_MS = 500

/**
 * Timer factory returning a cancel function. Overridable so tests drive the
 * coalesce/settle windows deterministically instead of waiting on real time.
 */
export type ApprovalTimer = (fn: () => void, ms: number) => () => void

export interface ApprovalDialogOptions {
  coalesceMs?: number
  settleMs?: number
  setTimer?: ApprovalTimer
}

const defaultTimer: ApprovalTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms)
  return () => {
    clearTimeout(handle)
  }
}

export function mountApprovalDialog(
  api: ApiClient,
  store: AppStore,
  options: ApprovalDialogOptions = {},
): void {
  const coalesceMs = options.coalesceMs ?? APPROVAL_COALESCE_MS
  const settleMs = options.settleMs ?? APPROVAL_SETTLE_MS
  const setTimer = options.setTimer ?? defaultTimer

  const rememberLabel = el(
    'label',
    { class: 'approval-remember' },
    el('input', { type: 'checkbox', class: 'approval-remember-input' }),
    'Always allow this tool',
  )
  // One heading for the whole prompt (fixed); the items scroll under it so a big
  // batch doesn't push the buttons off screen.
  const heading = el('h3', { class: 'approval-heading' })
  const items = el('div', { class: 'approval-items' })
  const dialog = el('dialog', { id: 'approval-dialog' })
  dialog.append(
    heading,
    items,
    rememberLabel,
    el(
      'div',
      { class: 'approval-buttons' },
      el('button', { class: 'approval-approve' }, 'Approve'),
      el('button', { class: 'approval-reject' }, 'Reject'),
    ),
  )
  document.body.append(dialog)

  const rememberInput = qsRequired<HTMLInputElement>(rememberLabel, '.approval-remember-input')
  const approveButton = qsRequired<HTMLButtonElement>(dialog, '.approval-approve')
  const rejectButton = qsRequired<HTMLButtonElement>(dialog, '.approval-reject')
  const rememberLabelTextNode = rememberLabel.childNodes[1]
  if (!rememberLabelTextNode) throw new Error('approval dialog missing remember label text node')
  const rememberLabelText: ChildNode = rememberLabelTextNode

  interface PendingApproval {
    id: string
    /** Thread this request belongs to; undefined = not tied to a run (show anywhere). */
    threadId: string | undefined
    title: string
    body: string
    allowRemember: boolean | undefined
    rememberLabel: string | undefined
  }

  // Requests waiting for their turn (background threads, or arrived before the
  // coalesce window elapsed). `batch` holds the requests currently on screen —
  // more than one when the agent fired several permission requests at once.
  const queue: PendingApproval[] = []
  let batch: PendingApproval[] = []
  let active = false
  // True between scheduling the opening delay and its callback firing, so a burst
  // of arrivals shares one timer (the delay counts from the *first* request, not
  // the last) and other surfacing paths don't double-open.
  let coalesceScheduled = false
  let cancelCoalesce: (() => void) | null = null
  // Cancels the pending Approve re-enable while the appended batch settles.
  let cancelSettle: (() => void) | null = null

  // Minimizing the window flips the renderer document to `hidden`. A modal shown
  // on a hidden window can't be painted, so it reads as a frozen/crashed pane and
  // the user has to switch threads (the only other showNext() trigger) to un-stick
  // it. While hidden we therefore treat *every* request like a background one:
  // defer it to the bell + dock bounce, and surface it on the next visibilitychange.
  function isWindowHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  // A request only interrupts if it belongs to the focused thread (or isn't tied
  // to a run at all) *and* the window can actually show it. Everything else stays
  // queued and is surfaced as a sidebar attention indicator until the user
  // switches to that thread or restores the window.
  function isShowable(req: PendingApproval): boolean {
    if (isWindowHidden()) return false
    return !req.threadId || req.threadId === store.getState().activeThreadId
  }

  // Reflect every queued request that can't currently pop a modal into the shared
  // attention set, so the sidebar can flag its thread with a bell. Normally that's
  // just *non-focused* threads; while the window is hidden it includes the focused
  // thread too, since its modal is deferred until the window comes back.
  function syncAttention(): void {
    const activeThreadId = store.getState().activeThreadId
    const hidden = isWindowHidden()
    const waiting = queue
      .map((req) => req.threadId)
      .filter((id): id is string => !!id && (hidden || id !== activeThreadId))
    setAttentionThreads(store, 'approval', waiting)
  }

  /** Move every currently-showable queued request onto the on-screen batch,
   * preserving arrival order (older requests stay at the top of the list). */
  function drainShowableIntoBatch(): number {
    let moved = 0
    for (let i = 0; i < queue.length; ) {
      const req = queue[i]
      if (req && isShowable(req)) {
        queue.splice(i, 1)
        batch.push(req)
        moved++
      } else {
        i++
      }
    }
    return moved
  }

  /**
   * The remember checkbox grants "always allow" for one agent+tool-kind (encoded
   * in `rememberLabel`). It only stays coherent when every batched request shares
   * that grant, so hide it for mixed batches rather than apply one label's grant
   * to unrelated calls.
   */
  function rememberGrant(): string | null {
    if (batch.length === 0) return null
    if (!batch.every((req) => req.allowRemember)) return null
    const label = batch[0]?.rememberLabel
    if (!label || !batch.every((req) => req.rememberLabel === label)) return null
    return label
  }

  function renderBatch(): void {
    const count = batch.length
    // Collapse the per-request title into one heading when the whole batch asks
    // the same question (parallel fetches/reads/shell — the common case). A mixed
    // batch gets a count heading and keeps a light per-row label so the rows stay
    // distinguishable.
    const uniqueTitles = new Set(batch.map((req) => req.title))
    const sharedTitle = uniqueTitles.size === 1 ? (batch[0]?.title ?? '') : null
    const showRowTitles = count > 1 && sharedTitle === null

    heading.textContent =
      count <= 1 ? (batch[0]?.title ?? '') : (sharedTitle ?? `${String(count)} requests`)

    items.replaceChildren(
      ...batch.map((req) => {
        const rowChildren: (Node | string)[] = []
        if (showRowTitles) rowChildren.push(el('div', { class: 'approval-item-title' }, req.title))
        rowChildren.push(el('pre', { class: 'approval-body' }, req.body))
        return el('div', { class: 'approval-item' }, ...rowChildren)
      }),
    )

    approveButton.textContent = count > 1 ? `Approve all (${String(count)})` : 'Approve'
    rejectButton.textContent = count > 1 ? `Reject all (${String(count)})` : 'Reject'

    const grant = rememberGrant()
    rememberLabel.hidden = grant === null
    if (grant === null) rememberInput.checked = false
    else rememberLabelText.textContent = grant
  }

  /** Cancel any pending settle window and re-enable Approve. */
  function clearSettle(): void {
    if (cancelSettle) {
      cancelSettle()
      cancelSettle = null
    }
    approveButton.disabled = false
  }

  /**
   * Disable Approve until the batch has held still for `settleMs`, restarting the
   * window on every append so a stream of arrivals keeps it disabled until it
   * stops. Reject is left enabled — see {@link APPROVAL_SETTLE_MS}.
   */
  function startSettle(): void {
    clearSettle()
    approveButton.disabled = true
    // A synchronous timer (tests) runs the callback before this assignment,
    // leaving `cancelSettle` holding a spent handle — harmless, since cancelling a
    // fired timer is a no-op and the enabled/disabled state is set by the callback.
    cancelSettle = setTimer(() => {
      cancelSettle = null
      approveButton.disabled = false
    }, settleMs)
  }

  /** Pop the dialog with whatever is showable now (no-op if nothing/blocked). */
  function show(): void {
    // The settings dialog is itself a top-layer modal <dialog>. A second
    // showModal() while it is open stacks the approval prompt *above* settings
    // (issue #501). Keep requests queued; onSettingsDialogClose() flushes them.
    if (isSettingsDialogOpen()) return
    if (active) return
    if (cancelCoalesce) {
      cancelCoalesce()
      cancelCoalesce = null
    }
    coalesceScheduled = false
    if (drainShowableIntoBatch() === 0) {
      syncAttention()
      return
    }
    // Fresh prompt the user is reading for the first time: Approve is live. The
    // settle guard only applies to appends onto an already-open prompt.
    clearSettle()
    rememberInput.checked = false
    renderBatch()
    dialog.showModal()
    active = true
    syncAttention()
  }

  /** First request of a burst: wait a beat for siblings, then pop once. */
  function scheduleShow(): void {
    if (active || coalesceScheduled) return
    if (!queue.some(isShowable)) {
      syncAttention()
      return
    }
    coalesceScheduled = true
    // As in startSettle, a synchronous timer leaves a spent handle here; the
    // open/queued decision keys off `coalesceScheduled`, not this handle.
    cancelCoalesce = setTimer(() => {
      coalesceScheduled = false
      cancelCoalesce = null
      show()
    }, coalesceMs)
  }

  /**
   * A request that landed while the dialog is open joins it live, and re-arms the
   * settle window so Approve can't be clicked through the change unseen.
   */
  function appendToOpen(): void {
    if (!active) return
    if (drainShowableIntoBatch() > 0) {
      renderBatch()
      startSettle()
    }
    syncAttention()
  }

  function resolve(approved: boolean, remember: boolean): void {
    if (!active || batch.length === 0) return
    const answered = batch
    dialog.close()
    batch = []
    active = false
    clearSettle()
    for (const req of answered) void api.approval.respond(req.id, approved, remember)
    // Surface anything that was waiting behind this batch immediately — it has
    // already sat through its own coalesce window, so no extra delay.
    show()
  }

  api.agent.onApprovalRequest(({ id, threadId, title, body, allowRemember, rememberLabel }) => {
    queue.push({ id, threadId, title, body, allowRemember, rememberLabel })
    if (active) appendToOpen()
    else scheduleShow()
    // scheduleShow/appendToOpen sync attention on their own paths, but a request
    // held back by the settings guard reaches neither; sync unconditionally.
    syncAttention()
  })

  // When the user switches threads, a previously-backgrounded request for the
  // now-focused thread should surface. `threads_changed` also fires on project
  // switches, so this covers cross-project focus changes too.
  store.on('threads_changed', () => {
    if (active) appendToOpen()
    else show()
  })

  // Restoring a minimized window makes deferred requests showable again; surface
  // them immediately so the user never has to switch threads to un-stick a prompt
  // that was held back while the window was hidden. show() no-ops while hidden,
  // so it only pops once the window is actually visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') show()
  })

  // Requests that arrived while the user was in Settings were held back by the
  // settings guard; surface them now that settings is closed.
  onSettingsDialogClose(() => {
    show()
  })

  approveButton.addEventListener('click', () => {
    // The settle guard disables the button, but honour it defensively in case a
    // click is dispatched anyway (e.g. keyboard activation during the window).
    if (approveButton.disabled) return
    resolve(true, rememberInput.checked)
  })
  rejectButton.addEventListener('click', () => {
    resolve(false, false)
  })
}
