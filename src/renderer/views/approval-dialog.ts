import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

export function mountApprovalDialog(api: ApiClient): void {
  const dialog = el('dialog', { id: 'approval-dialog' })
  dialog.append(
    el('h3', { class: 'approval-title' }),
    el('pre', { class: 'approval-body' }),
    el(
      'div',
      { class: 'approval-buttons' },
      el('button', { class: 'approval-approve' }, 'Approve'),
      el('button', { class: 'approval-reject' }, 'Reject'),
    ),
  )
  document.body.append(dialog)

  let currentId = ''

  api.agent.onApprovalRequest(({ id, title, body }) => {
    currentId = id
    dialog.querySelector('.approval-title')!.textContent = title
    dialog.querySelector('.approval-body')!.textContent = body
    dialog.showModal()
  })

  dialog.querySelector('.approval-approve')!.addEventListener('click', () => {
    dialog.close()
    void api.approval.respond(currentId, true)
  })
  dialog.querySelector('.approval-reject')!.addEventListener('click', () => {
    dialog.close()
    void api.approval.respond(currentId, false)
  })
}
