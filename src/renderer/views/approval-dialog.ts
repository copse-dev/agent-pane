import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

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

  const rememberInput = rememberLabel.querySelector('.approval-remember-input') as HTMLInputElement

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
    active = queue.shift() ?? null
    if (!active) return
    dialog.querySelector('.approval-title')!.textContent = active.title
    dialog.querySelector('.approval-body')!.textContent = active.body
    rememberLabel.childNodes[1]!.textContent = active.rememberLabel ?? 'Always allow this tool'
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

  dialog.querySelector('.approval-approve')!.addEventListener('click', () => {
    resolve(true, rememberInput.checked)
  })
  dialog.querySelector('.approval-reject')!.addEventListener('click', () => {
    resolve(false, false)
  })
}
