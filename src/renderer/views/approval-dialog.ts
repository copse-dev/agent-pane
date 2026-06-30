import { el, qsRequired } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { isSettingsDialogOpen, onSettingsDialogClose } from './settings-dialog.ts'

export function mountApprovalDialog(api: ApiClient): void {
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

  function showNext(): void {
    // The settings dialog is itself a top-layer modal <dialog>. A second
    // showModal() while it is open stacks the approval prompt *above* settings
    // (issue #501), even though the request came from a background chat. Keep
    // such requests queued; onSettingsDialogClose() below flushes them once the
    // user leaves settings, so the prompt appears in front of the chat instead.
    if (isSettingsDialogOpen()) return
    active = queue.shift() ?? null
    if (!active) return
    approvalTitle.textContent = active.title
    approvalBody.textContent = active.body
    rememberLabelText.textContent = active.rememberLabel ?? 'Always allow this tool'
    rememberInput.checked = false
    rememberLabel.hidden = !active.allowRemember
    dialog.showModal()
  }

  function resolve(approved: boolean, remember: boolean): void {
    const current = active
    if (!current) return
    dialog.close()
    active = null
    void api.approval.respond(current.id, approved, remember)
    showNext()
  }

  api.agent.onApprovalRequest(({ id, title, body, allowRemember, rememberLabel }) => {
    queue.push({ id, title, body, allowRemember, rememberLabel })
    if (!active) showNext()
  })

  // Requests that arrived while the user was in Settings were held back by
  // showNext()'s guard; surface them now that settings is closed.
  onSettingsDialogClose(() => {
    if (!active) showNext()
  })

  qsRequired(dialog, '.approval-approve').addEventListener('click', () => {
    resolve(true, rememberInput.checked)
  })
  qsRequired(dialog, '.approval-reject').addEventListener('click', () => {
    resolve(false, false)
  })
}
