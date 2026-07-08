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

/** Defers `fn` to gather the opening burst; overridable so tests run it inline. */
export type CoalesceScheduler = (fn: () => void) => void

const defaultScheduler: CoalesceScheduler = (fn) => {
  setTimeout(fn, APPROVAL_COALESCE_MS)
}

export function mountApprovalDialog(
  api: ApiClient,
  store: AppStore,
  scheduleCoalesce: CoalesceScheduler = defaultScheduler,
): void {
  const rememberLabel = el(
    'label',
    { class: 'approval-remember' },
    el('input', { type: 'checkbox', class: 'approval-remember-input' }),
    'Always allow this tool',
  )
  const list = el('div', { class: 'approval-list' })
  const dialog = el('dialog', { id: 'approval-dialog' })
  dialog.append(
    list,
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
  const approveButton = qsRequired(dialog, '.approval-approve')
  const rejectButton = qsRequired(dialog, '.approval-reject')
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
    list.replaceChildren(
      ...batch.map((req) =>
        el(
          'div',
          { class: 'approval-item' },
          el('h3', { class: 'approval-title' }, req.title),
          el('pre', { class: 'approval-body' }, req.body),
        ),
      ),
    )
    const count = batch.length
    approveButton.textContent = count > 1 ? `Approve all (${String(count)})` : 'Approve'
    rejectButton.textContent = count > 1 ? `Reject all (${String(count)})` : 'Reject'

    const grant = rememberGrant()
    rememberLabel.hidden = grant === null
    if (grant === null) rememberInput.checked = false
    else rememberLabelText.textContent = grant
  }

  /** Pop the dialog with whatever is showable now (no-op if nothing/blocked). */
  function show(): void {
    // The settings dialog is itself a top-layer modal <dialog>. A second
    // showModal() while it is open stacks the approval prompt *above* settings
    // (issue #501). Keep requests queued; onSettingsDialogClose() flushes them.
    if (isSettingsDialogOpen()) return
    if (active) return
    if (drainShowableIntoBatch() === 0) {
      syncAttention()
      return
    }
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
    scheduleCoalesce(() => {
      coalesceScheduled = false
      show()
    })
  }

  /** A request that landed while the dialog is open joins it live. */
  function appendToOpen(): void {
    if (!active) return
    if (drainShowableIntoBatch() > 0) renderBatch()
    syncAttention()
  }

  function resolve(approved: boolean, remember: boolean): void {
    if (!active || batch.length === 0) return
    const answered = batch
    dialog.close()
    batch = []
    active = false
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
    resolve(true, rememberInput.checked)
  })
  rejectButton.addEventListener('click', () => {
    resolve(false, false)
  })
}
