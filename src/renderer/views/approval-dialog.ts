import type { ApiClient } from '../../preload/api.d.ts'

export function mountApprovalDialog(api: ApiClient): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'approval-dialog'
  dialog.innerHTML = `
    <h3 class="approval-title"></h3>
    <pre class="approval-body"></pre>
    <div class="approval-buttons">
      <button class="approval-approve">Approve</button>
      <button class="approval-reject">Reject</button>
    </div>
  `
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
