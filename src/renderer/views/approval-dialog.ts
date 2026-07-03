import { el, qsRequired } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { isSettingsDialogOpen, onSettingsDialogClose } from './settings-dialog.ts'
import { setAttentionThreads } from '../controller/attention.ts'

export function mountApprovalDialog(api: ApiClient, store: AppStore): void {
  const rememberLabel = el(
    'label',
    { class: 'approval-remember' },
    el('input', { type: 'checkbox', class: 'approval-remember-input' }),
    'Always allow this tool',
  )
  const dialog = el('dialog', { id: 'approval-dialog' })
  dialog.append(
    el('h3', { class: 'approval-title' }),
    el('pre', { class: 'approval-body' }),
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

  const approvalTitle = qsRequired(dialog, '.approval-title')
  const approvalBody = qsRequired(dialog, '.approval-body')
  const rememberLabelTextNode = rememberLabel.childNodes[1]
  if (!rememberLabelTextNode) throw new Error('approval dialog missing remember label text node')
  // Bind to an explicitly non-optional type so the narrowing survives into the
  // showNext() closure below.
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

  // A single shared `currentId` mis-routed answers when a second request arrived
  // while the first was still open: the second overwrote the id, so clicking
  // Approve/Reject answered the wrong (second) request and the first hung.
  // Queue requests and show them one at a time, binding each answer to the
  // request actually on screen.
  const queue: PendingApproval[] = []
  let active: PendingApproval | null = null

  // A request only interrupts if it belongs to the focused thread (or isn't
  // tied to a run at all). Everything else stays queued and is surfaced as a
  // sidebar attention indicator until the user switches to that thread.
  function isShowable(req: PendingApproval): boolean {
    return !req.threadId || req.threadId === store.getState().activeThreadId
  }

  // Reflect every queued request that belongs to a *non-focused* thread into the
  // shared attention set, so the sidebar can flag those threads with a bell.
  function syncAttention(): void {
    const activeThreadId = store.getState().activeThreadId
    const waiting = queue
      .map((req) => req.threadId)
      .filter((id): id is string => !!id && id !== activeThreadId)
    setAttentionThreads(store, 'approval', waiting)
  }

  function showNext(): void {
    // The settings dialog is itself a top-layer modal <dialog>. A second
    // showModal() while it is open stacks the approval prompt *above* settings
    // (issue #501), even though the request came from a background chat. Keep
    // such requests queued; onSettingsDialogClose() below flushes them once the
    // user leaves settings, so the prompt appears in front of the chat instead.
    if (isSettingsDialogOpen()) return
    if (active) return
    const idx = queue.findIndex(isShowable)
    if (idx === -1) {
      // Nothing for the focused thread; anything left is background attention.
      syncAttention()
      return
    }
    active = queue.splice(idx, 1)[0] ?? null
    if (!active) return
    approvalTitle.textContent = active.title
    approvalBody.textContent = active.body
    rememberLabelText.textContent = active.rememberLabel ?? 'Always allow this tool'
    rememberInput.checked = false
    rememberLabel.hidden = !active.allowRemember
    dialog.showModal()
    syncAttention()
  }

  function resolve(approved: boolean, remember: boolean): void {
    const current = active
    if (!current) return
    dialog.close()
    active = null
    void api.approval.respond(current.id, approved, remember)
    showNext()
  }

  api.agent.onApprovalRequest(({ id, threadId, title, body, allowRemember, rememberLabel }) => {
    queue.push({ id, threadId, title, body, allowRemember, rememberLabel })
    showNext()
    // showNext() skips its attention sync when a modal is already up or Settings
    // is open; sync unconditionally so a background request still flags its
    // thread in those cases.
    syncAttention()
  })

  // When the user switches threads, a previously-backgrounded request for the
  // now-focused thread should surface. `threads_changed` also fires on project
  // switches, so this covers cross-project focus changes too.
  store.on('threads_changed', () => {
    showNext()
  })

  // Requests that arrived while the user was in Settings were held back by
  // showNext()'s guard; surface them now that settings is closed.
  onSettingsDialogClose(() => {
    showNext()
  })

  qsRequired(dialog, '.approval-approve').addEventListener('click', () => {
    resolve(true, rememberInput.checked)
  })
  qsRequired(dialog, '.approval-reject').addEventListener('click', () => {
    resolve(false, false)
  })
}
