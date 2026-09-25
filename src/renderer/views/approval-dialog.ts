import { el, qsRequired } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isSettingsDialogOpen, onSettingsDialogClose } from './settings-dialog.ts'
import { setAttentionThreads } from '../controller/attention.ts'
import { uiActions } from '../ui/actions.ts'

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

/** Marker `permission-policy.ts` prefixes each reason line with. */
const ADVICE_BULLET = '\u2022 '

/**
 * Advice text, with each reason bullet as its own inline-block so a line too long
 * for the dialog hangs under its own text instead of returning to the left margin,
 * where it reads as another bullet.
 *
 * The newlines stay as text nodes between the spans, so the element's
 * `textContent` is still exactly the string the main process sent.
 */
export function adviceElement(advice: string): HTMLElement {
  const children: (Node | string)[] = []
  advice.split('\n').forEach((line, index) => {
    if (index > 0) children.push('\n')
    children.push(
      line.startsWith(ADVICE_BULLET) ? el('span', { class: 'approval-advice-item' }, line) : line,
    )
  })
  return el('div', { class: 'approval-advice' }, ...children)
}

/**
 * One request exactly as a single-request prompt presents it, fully expanded:
 * the advice, the whole body (monospaced for shell), then the footer. Shared
 * with the Activity panel so a request is never approved from a view that shows
 * less than this prompt would. Nothing is truncated; a long body scrolls.
 */
export function approvalRequestDetails(req: {
  body: string
  bodyAdvice: string | undefined
  bodyFooter: string | undefined
  type: string
}): HTMLElement[] {
  const parts: HTMLElement[] = []
  if (req.bodyAdvice) parts.push(adviceElement(req.bodyAdvice))
  parts.push(
    el(
      'div',
      { class: req.type === 'shell' ? 'approval-body approval-body-code' : 'approval-body' },
      req.body,
    ),
  )
  if (req.bodyFooter) parts.push(el('div', { class: 'approval-footer' }, req.bodyFooter))
  return parts
}

/**
 * Combine the distinct explanations for one grouped decision. Permission copy
 * commonly shares a lead line followed by request-specific bullets; keep that
 * lead once and preserve every unique detail below it. Unstructured advice stays
 * intact as separate paragraphs.
 */
function mergeApprovalAdvice(values: readonly (string | undefined)[]): string | undefined {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  if (unique.length <= 1) return unique[0]

  const lines = unique.map((value) => value.split('\n'))
  const sharedLead = lines[0]?.[0]
  if (sharedLead === undefined || !lines.every((parts) => parts[0] === sharedLead)) {
    return unique.join('\n\n')
  }

  const merged = [sharedLead]
  const seenDetails = new Set<string>()
  for (const parts of lines) {
    const details = parts.slice(1).join('\n')
    if (!details || seenDetails.has(details)) continue
    seenDetails.add(details)
    merged.push(details)
  }
  return merged.join('\n')
}

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

/** What another surface (the Activity panel) may read about one pending approval. */
export interface PendingApprovalSummary {
  id: string
  /** Thread the request belongs to; undefined when it is not tied to a run. */
  threadId: string | undefined
  title: string
  body: string
  bodyAdvice: string | undefined
  bodyFooter: string | undefined
  type: string
  /** Renderer clock when the request arrived — how long it has been waiting. */
  receivedAt: number
}

/**
 * The dialog's pending requests, exposed so a second surface can list and answer
 * them without growing a second approval path. The dialog stays the only owner
 * of its queue and the only caller of `approval.respond`.
 */
export interface ApprovalRequests {
  /** Every request still waiting for an answer — on screen or queued — oldest first. */
  pending(): PendingApprovalSummary[]
  /**
   * Answer one request with the narrowest decision the prompt offers: approve
   * this request once (no remembered grant, no task lease), or reject it.
   *
   * Returns false, and sends nothing, when the request is no longer pending —
   * it was answered here or on the prompt already, or main cancelled it. That is
   * what makes a double click or a stale row harmless.
   */
  answerOnce(id: string, approved: boolean): boolean
  /** Called after any change to {@link pending}. Returns an unsubscribe. */
  onChange(listener: () => void): () => void
}

export function mountApprovalDialog(
  api: ApiClient,
  store: AppStore,
  options: ApprovalDialogOptions = {},
): ApprovalRequests {
  const coalesceMs = options.coalesceMs ?? APPROVAL_COALESCE_MS
  const settleMs = options.settleMs ?? APPROVAL_SETTLE_MS
  const setTimer = options.setTimer ?? defaultTimer

  const rememberLabel = el(
    'label',
    { class: 'approval-remember' },
    el('input', { type: 'checkbox', class: 'approval-remember-input' }),
    'Always allow this tool',
  )
  const turnTreeLeaseLabel = el(
    'label',
    { class: 'approval-remember approval-turn-tree' },
    el('input', { type: 'checkbox', class: 'approval-turn-tree-input' }),
    'Allow retries for this task (up to 10, for 15 minutes)',
  )
  // One heading for the whole prompt (fixed); the items scroll under it so a big
  // batch doesn't push the buttons off screen.
  const heading = el('h3', { class: 'approval-heading' })
  const items = el('div', { class: 'approval-items' })
  const chatScrim = el('div', { class: 'approval-chat-scrim', 'aria-hidden': 'true', hidden: '' })
  // Kit classes carry the look; legacy approval-* hooks stay for existing selectors/tests.
  const approveOnceButton = el('button', {
    type: 'button',
    class: 'ui-btn ui-btn-secondary approval-approve-once',
    hidden: '',
  })
  const approveButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary approval-approve' },
    'Approve',
  )
  const rejectButton = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary approval-reject' },
    'Reject',
  )
  const dialog = el('dialog', { id: 'approval-dialog' })
  dialog.append(
    heading,
    items,
    rememberLabel,
    turnTreeLeaseLabel,
    uiActions(approveOnceButton, approveButton, rejectButton, {
      className: 'approval-buttons',
      align: 'end',
    }),
  )
  // Approval is intentionally owned by the chat pane rather than the window:
  // the scrim blocks the transcript/composer while the adjacent terminal and
  // other right-panel tools remain interactive. Tests that mount this view in
  // isolation have no app shell, so body is the harmless fallback host.
  const chatPane = document.getElementById('pane-chat') ?? document.body
  chatPane.append(chatScrim, dialog)

  const rememberInput = qsRequired<HTMLInputElement>(rememberLabel, '.approval-remember-input')
  const turnTreeLeaseInput = qsRequired<HTMLInputElement>(
    turnTreeLeaseLabel,
    '.approval-turn-tree-input',
  )
  const turnTreeLeaseTextNode = turnTreeLeaseLabel.childNodes[1]
  if (!turnTreeLeaseTextNode) throw new Error('approval dialog missing lease label text node')
  const turnTreeLeaseText: ChildNode = turnTreeLeaseTextNode
  const rememberLabelTextNode = rememberLabel.childNodes[1]
  if (!rememberLabelTextNode) throw new Error('approval dialog missing remember label text node')
  const rememberLabelText: ChildNode = rememberLabelTextNode

  interface PendingApproval {
    id: string
    /** Thread this request belongs to; undefined = not tied to a run (show anywhere). */
    threadId: string | undefined
    title: string
    body: string
    bodyAdvice: string | undefined
    bodyFooter: string | undefined
    type: string
    allowRemember: boolean | undefined
    rememberLabel: string | undefined
    collapseDetails: boolean | undefined
    approveOnceLabel: string | undefined
    showWhileSettingsOpen: boolean | undefined
    allowTurnTreeLease: boolean | undefined
    turnTreeLeaseLabel: string | undefined
    turnTreeLeaseDefault: boolean | undefined
    turnTreeLeaseSubject: string | undefined
    receivedAt: number
    /** Arrival order; the clock alone ties within a millisecond. */
    arrival: number
  }

  const changeListeners = new Set<() => void>()
  let arrivals = 0

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
  /** Whether the user expanded a collapsed body on the open prompt. */
  let detailsExpanded = false
  function closeDialog(): void {
    dialog.close()
    chatScrim.hidden = true
  }

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
    if (isSettingsDialogOpen() && !req.showWhileSettingsOpen) return false
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
    // Every queue/batch mutation ends here, so this is the one place the
    // pending set is announced to other surfaces.
    for (const listener of [...changeListeners]) listener()
  }

  /** Move every currently-showable queued request onto the on-screen batch,
   * preserving arrival order (older requests stay at the top of the list). */
  function drainShowableIntoBatch(): number {
    let moved = 0
    for (let i = 0; i < queue.length;) {
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

  /**
   * The prompt's two-tier approve (primary grants, secondary approves once) and
   * its collapsed body are only coherent for a lone request: in a mixed batch a
   * grant answered for one command would be sent for every other one too. So
   * both features require a batch of exactly one, and anything appended to an
   * open prompt drops it back to the plain checkbox rendering.
   */
  function soloRequest(): PendingApproval | null {
    return batch.length === 1 ? (batch[0] ?? null) : null
  }

  /** Label for the secondary approve button, or '' when this prompt has none. */
  function approveOnceGrant(): string {
    return soloRequest()?.approveOnceLabel ?? ''
  }

  /** Disclosure control for a collapsed body; re-renders so the buttons follow it. */
  function detailsToggle(): HTMLElement {
    const toggle = el(
      'button',
      {
        class: 'approval-details-toggle',
        type: 'button',
        'aria-expanded': detailsExpanded ? 'true' : 'false',
      },
      detailsExpanded ? 'Hide details' : 'Show details',
    )
    toggle.addEventListener('click', () => {
      detailsExpanded = !detailsExpanded
      renderBatch()
    })
    return toggle
  }

  function renderBatch(): void {
    const count = batch.length
    const collapseDetails = soloRequest()?.collapseDetails === true
    // Collapse the per-request title into one heading when the whole batch asks
    // the same question (parallel fetches/reads/shell — the common case). A mixed
    // batch gets a count heading and keeps a light per-row label so the rows stay
    // distinguishable.
    const uniqueTitles = new Set(batch.map((req) => req.title))
    const sharedTitle = uniqueTitles.size === 1 ? (batch[0]?.title ?? '') : null
    const showRowTitles = count > 1 && sharedTitle === null
    // Collapse each adjacent run that asks the same question and offers the same
    // answer. Keeping groups contiguous preserves request order: an A/B/A batch
    // stays A, B, A. Advice may still differ within a group; it is merged above
    // one continuous body list so every safety reason remains visible without
    // splitting one decision into several bordered sections.
    const presentationGroups: PendingApproval[][] = []
    for (const req of batch) {
      const previousGroup = presentationGroups.at(-1)
      const previous = previousGroup?.[0]
      if (
        previousGroup &&
        previous &&
        req.type === previous.type &&
        req.title === previous.title &&
        req.bodyFooter === previous.bodyFooter
      ) {
        previousGroup.push(req)
      } else {
        presentationGroups.push([req])
      }
    }

    heading.textContent =
      count <= 1 ? (batch[0]?.title ?? '') : (sharedTitle ?? `${String(count)} requests`)

    const requestBody = (req: PendingApproval): HTMLElement => {
      // Shell commands stay monospaced; other prompts (PR targets, origins) use the
      // interface font so they don't read as a raw JSON dump in a <pre>.
      const bodyClass = req.type === 'shell' ? 'approval-body approval-body-code' : 'approval-body'
      const body = el('div', { class: bodyClass }, req.body)
      if (collapseDetails && !detailsExpanded) body.hidden = true
      return body
    }

    items.replaceChildren(
      ...presentationGroups.map((group) => {
        const firstRequest = group[0]
        if (!firstRequest) throw new Error('approval presentation group must not be empty')
        const rowChildren: (Node | string)[] = []
        if (showRowTitles) {
          rowChildren.push(el('div', { class: 'approval-item-title' }, firstRequest.title))
        }
        const advice = mergeApprovalAdvice(group.map((request) => request.bodyAdvice))
        if (advice) {
          rowChildren.push(adviceElement(advice))
        }
        if (collapseDetails) rowChildren.push(detailsToggle())
        if (group.length > 1) {
          const bodyLabel =
            firstRequest.type === 'shell' ? 'Commands requiring approval' : 'Requests'
          rowChildren.push(
            el(
              'div',
              { class: 'approval-body-list', role: 'list', 'aria-label': bodyLabel },
              ...group.map((req) => {
                const body = requestBody(req)
                body.setAttribute('role', 'listitem')
                return body
              }),
            ),
          )
        } else {
          rowChildren.push(requestBody(firstRequest))
        }
        if (firstRequest.bodyFooter) {
          rowChildren.push(el('div', { class: 'approval-footer' }, firstRequest.bodyFooter))
        }
        return el('div', { class: 'approval-item' }, ...rowChildren)
      }),
    )

    approveButton.textContent = count > 1 ? `Approve all (${String(count)})` : 'Approve'
    rejectButton.textContent = count > 1 ? `Reject all (${String(count)})` : 'Reject'

    // The narrower answer is offered alongside the details it refers to: with the
    // command still collapsed there is nothing on screen for "this command" to
    // point at, so the button waits for the disclosure.
    const onceLabel = approveOnceGrant()
    const showOnce = onceLabel !== '' && (!collapseDetails || detailsExpanded)
    approveOnceButton.hidden = !showOnce
    if (showOnce) approveOnceButton.textContent = onceLabel

    // A two-tier prompt owns the remember channel through its buttons, so the
    // checkbox stays out of the way rather than offering a second, conflicting
    // way to answer the same question.
    const grant = onceLabel !== '' ? null : rememberGrant()
    rememberLabel.hidden = grant === null
    if (grant === null) rememberInput.checked = false
    else rememberLabelText.textContent = grant

    // One tick box settles the whole batch, but the main process issues a lease
    // per request — so the offer is only coherent when every batched request
    // would lease the SAME command. The label alone can't establish that: it's a
    // fixed string shared by every shell prompt, so unrelated commands compare
    // equal on it. Match on the subject too, and hide the box otherwise, exactly
    // as rememberGrant() does rather than applying one grant to unrelated calls.
    const leaseLabel = batch[0]?.turnTreeLeaseLabel
    const leaseSubject = batch[0]?.turnTreeLeaseSubject
    const offersTurnTreeLease =
      batch.length > 0 &&
      leaseLabel !== undefined &&
      leaseSubject !== undefined &&
      batch.every(
        (request) =>
          request.allowTurnTreeLease === true &&
          request.turnTreeLeaseLabel === leaseLabel &&
          request.turnTreeLeaseSubject === leaseSubject,
      )
    turnTreeLeaseLabel.hidden = !offersTurnTreeLease
    if (!offersTurnTreeLease) turnTreeLeaseInput.checked = false
    else {
      turnTreeLeaseText.textContent = leaseLabel
      // Sandboxed approval includes bounded retries by default. Outside-sandbox
      // retries remain explicit, and mixed-command batches hide the grant above.
      turnTreeLeaseInput.checked = batch.every((request) => request.turnTreeLeaseDefault === true)
    }
  }

  /** Cancel any pending settle window and re-enable both approve buttons. */
  function clearSettle(): void {
    if (cancelSettle) {
      cancelSettle()
      cancelSettle = null
    }
    approveButton.disabled = false
    approveOnceButton.disabled = false
  }

  /**
   * Disable Approve until the batch has held still for `settleMs`, restarting the
   * window on every append so a stream of arrivals keeps it disabled until it
   * stops. Reject is left enabled — see {@link APPROVAL_SETTLE_MS}.
   */
  function startSettle(): void {
    clearSettle()
    approveButton.disabled = true
    approveOnceButton.disabled = true
    // A synchronous timer (tests) runs the callback before this assignment,
    // leaving `cancelSettle` holding a spent handle — harmless, since cancelling a
    // fired timer is a no-op and the enabled/disabled state is set by the callback.
    cancelSettle = setTimer(() => {
      cancelSettle = null
      approveButton.disabled = false
      approveOnceButton.disabled = false
    }, settleMs)
  }

  /** Pop the dialog with whatever is showable now (no-op if nothing/blocked). */
  function show(): void {
    // isShowable() keeps ordinary requests queued behind Settings (issue #501),
    // while Settings-owned provider-host approvals may intentionally stack above
    // it so the save flow can finish without first closing Settings.
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
    // Each prompt starts collapsed; expanding is a per-prompt decision.
    detailsExpanded = false
    renderBatch()
    // A Settings-owned provider-host prompt is the one deliberate modal
    // exception: Settings already makes the document inert, so an inline prompt
    // could not be answered. Pop-out windows also have no visible chat pane.
    const shouldShowModal =
      isSettingsDialogOpen() || document.documentElement.classList.contains('is-popout')
    if (shouldShowModal) {
      dialog.showModal()
    } else {
      chatScrim.hidden = false
      dialog.show()
    }
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
   * Pull requests that have stopped being showable back off the open prompt.
   *
   * `isShowable` is checked when a request is surfaced but the batch was never
   * re-examined afterwards, so a prompt raised for one thread stayed on screen
   * when the user moved to another thread — or to another project entirely,
   * since a project switch swaps `activeThreadId` too. The result read as a
   * question asked by the thread just opened, over a transcript that never asked
   * it, and answering it approved a tool call in the project left behind.
   *
   * Withdrawn requests go back to the front of the queue (as the settings
   * interrupt below re-queues them), so they surface again in arrival order when
   * the user returns to their thread; until then they show as a sidebar bell.
   */
  function withdrawUnshowable(): void {
    if (!active) return
    const withdrawn = batch.filter((req) => !isShowable(req))
    if (withdrawn.length === 0) return
    batch = batch.filter((req) => isShowable(req))
    queue.unshift(...withdrawn)
    if (batch.length === 0) {
      closeDialog()
      active = false
      clearSettle()
      return
    }
    // What is left is a different prompt from the one the user was reading, so
    // it starts collapsed exactly as show() opens one: expansion was a decision
    // about the withdrawn request, and carrying it over would offer "approve
    // just this one" against details the user never opened.
    detailsExpanded = false
    // The batch changed under the user, so the same clickjack guard an append
    // arms applies here: a click committed against the old list must not land on
    // the new one.
    renderBatch()
    startSettle()
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

  function removeCancelled(id: string): void {
    const queueIdx = queue.findIndex((req) => req.id === id)
    if (queueIdx >= 0) queue.splice(queueIdx, 1)
    const wasInBatch = batch.some((req) => req.id === id)
    batch = batch.filter((req) => req.id !== id)
    if (wasInBatch && active) {
      if (batch.length === 0) {
        closeDialog()
        active = false
        clearSettle()
        show()
      } else {
        renderBatch()
        // Removing a sibling can change the remaining primary action from a
        // one-shot batch approval into a broader solo grant (for example read
        // access outside the project). Treat that semantic change like a live
        // append so a click committed against the old label cannot land on the
        // newly broadened action. Reject deliberately stays available.
        startSettle()
      }
    }
    syncAttention()
  }

  function resolve(approved: boolean, remember: boolean): void {
    if (!active || batch.length === 0) return
    const answered = batch
    const grantScope =
      approved && !turnTreeLeaseLabel.hidden && turnTreeLeaseInput.checked ? 'turn-tree' : 'once'
    closeDialog()
    batch = []
    active = false
    turnTreeLeaseInput.checked = false
    clearSettle()
    for (const req of answered) {
      void api.approval.respond(req.id, approved, remember, grantScope)
    }
    // Surface anything that was waiting behind this batch immediately — it has
    // already sat through its own coalesce window, so no extra delay.
    show()
  }

  api.agent.onApprovalRequest(
    ({
      id,
      threadId,
      title,
      body,
      bodyAdvice,
      bodyFooter,
      type,
      allowRemember,
      rememberLabel,
      collapseDetails,
      approveOnceLabel,
      showWhileSettingsOpen,
      allowTurnTreeLease,
      turnTreeLeaseLabel,
      turnTreeLeaseDefault,
      turnTreeLeaseSubject,
    }) => {
      const pending: PendingApproval = {
        id,
        threadId,
        title,
        body,
        bodyAdvice,
        bodyFooter,
        type,
        allowRemember,
        rememberLabel,
        collapseDetails,
        approveOnceLabel,
        showWhileSettingsOpen,
        allowTurnTreeLease,
        turnTreeLeaseLabel,
        turnTreeLeaseDefault,
        turnTreeLeaseSubject,
        receivedAt: Date.now(),
        arrival: arrivals++,
      }
      queue.push(pending)
      if (active && isSettingsDialogOpen() && pending.showWhileSettingsOpen) {
        // Settings may have been opened after an ordinary inline approval was
        // already visible. Its modal top layer makes that chat prompt inert, so
        // put the interrupted batch back at the front and surface only the
        // Settings-owned request modally. The older batch resumes after Settings
        // closes; this also keeps unrelated grants out of the provider prompt.
        queue.unshift(...batch)
        batch = []
        closeDialog()
        active = false
        clearSettle()
        show()
      } else if (active) appendToOpen()
      else scheduleShow()
      // scheduleShow/appendToOpen sync attention on their own paths, but a request
      // held back by the settings guard reaches neither; sync unconditionally.
      syncAttention()
    },
  )

  api.agent.onApprovalCancelled(({ id }) => {
    removeCancelled(id)
  })

  // When the user switches threads, the prompt on screen has to follow the
  // focus: requests for the thread just left are withdrawn, and a
  // previously-backgrounded request for the now-focused thread surfaces.
  // `threads_changed` also fires on project switches, so this covers
  // cross-project focus changes too.
  store.on('threads_changed', () => {
    withdrawUnshowable()
    if (active) appendToOpen()
    else show()
  })

  // Restoring a minimized window makes deferred requests showable again; surface
  // them immediately so the user never has to switch threads to un-stick a prompt
  // that was held back while the window was hidden. Going the other way, a prompt
  // already open when the window is hidden is withdrawn for the same reason new
  // ones are deferred: it cannot be painted, so it would read as a frozen pane.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      withdrawUnshowable()
      syncAttention()
    } else show()
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
    // On a two-tier prompt the primary button IS the grant — the checkbox is
    // hidden there, and the secondary button carries the once-only answer.
    resolve(true, approveOnceGrant() !== '' ? true : rememberInput.checked)
  })
  approveOnceButton.addEventListener('click', () => {
    if (approveOnceButton.disabled) return
    resolve(true, false)
  })
  rejectButton.addEventListener('click', () => {
    resolve(false, false)
  })

  return {
    pending: () =>
      [...batch, ...queue]
        .sort((a, b) => a.arrival - b.arrival)
        .map((req) => ({
          id: req.id,
          threadId: req.threadId,
          title: req.title,
          body: req.body,
          bodyAdvice: req.bodyAdvice,
          bodyFooter: req.bodyFooter,
          type: req.type,
          receivedAt: req.receivedAt,
        })),
    answerOnce: (id, approved): boolean => {
      if (!batch.some((req) => req.id === id) && !queue.some((req) => req.id === id)) return false
      // Taken off the dialog first, exactly as a cancellation would be: an open
      // prompt that still holds siblings re-renders and re-arms its settle
      // guard, and an emptied one closes and surfaces whatever waited behind it.
      removeCancelled(id)
      void api.approval.respond(id, approved, false, 'once')
      return true
    },
    onChange: (listener) => {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
  }
}
