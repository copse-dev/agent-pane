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

  let currentId = ''

  api.agent.onApprovalRequest(({ id, title, body, allowRemember }) => {
    currentId = id
    dialog.querySelector('.approval-title')!.textContent = title
    dialog.querySelector('.approval-body')!.textContent = body
    rememberInput.checked = false
    rememberLabel.hidden = !allowRemember
    dialog.showModal()
  })

  dialog.querySelector('.approval-approve')!.addEventListener('click', () => {
    dialog.close()
    void api.approval.respond(currentId, true, rememberInput.checked)
  })
  dialog.querySelector('.approval-reject')!.addEventListener('click', () => {
    dialog.close()
    void api.approval.respond(currentId, false, false)
  })
}
