import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'

interface SshPromptRequest {
  id: string
  prompt: string
  kind: 'confirm' | 'secret'
}

/**
 * Modal for SSH/GIT askpass prompts (passphrase, host-key confirmation, etc.).
 * Runs outside the agent thread-attention model — these prompts are tied to a
 * local subprocess, not an agent run.
 */
export function mountSshPromptDialog(api: ApiClient): void {
  const promptEl = el('pre', { class: 'ssh-prompt-body' })
  const secretInput = el('input', {
    type: 'password',
    class: 'ssh-prompt-input',
    autocomplete: 'off',
  })
  const secretField = el('div', { class: 'ssh-prompt-secret-field' }, secretInput)
  const form = el('form', { id: 'ssh-prompt-form', method: 'dialog' })
  const dialog = el('dialog', { id: 'ssh-prompt-dialog' }, form)
  document.body.append(dialog)

  const cancelBtn = el('button', { type: 'button', class: 'ssh-prompt-cancel' }, 'Cancel')
  const submitBtn = el('button', { type: 'submit', class: 'ssh-prompt-submit' }, 'Continue')
  const confirmApprove = el('button', { type: 'button', class: 'ssh-prompt-submit' }, 'Continue')
  const confirmReject = el('button', { type: 'button', class: 'ssh-prompt-cancel' }, 'Cancel')
  const confirmButtons = el('div', { class: 'ssh-prompt-buttons' }, confirmReject, confirmApprove)
  const secretButtons = el('div', { class: 'ssh-prompt-buttons' }, cancelBtn, submitBtn)

  form.append(
    el('h3', { class: 'ssh-prompt-title' }, 'SSH authentication'),
    promptEl,
    secretField,
    confirmButtons,
    secretButtons,
  )

  const queue: SshPromptRequest[] = []
  let active: SshPromptRequest | null = null

  function showKind(kind: SshPromptRequest['kind']): void {
    const confirm = kind === 'confirm'
    secretField.hidden = confirm
    secretButtons.hidden = confirm
    confirmButtons.hidden = !confirm
  }

  function renderActive(): void {
    if (!active) return
    promptEl.textContent = active.prompt
    secretInput.value = ''
    showKind(active.kind)
    dialog.showModal()
    if (active.kind === 'secret') secretInput.focus()
    else confirmApprove.focus()
  }

  function finish(value: string): void {
    if (!active) return
    const id = active.id
    active = null
    dialog.close()
    void api.sshPrompt.respond(id, value)
    if (queue.length > 0) {
      active = queue.shift() ?? null
      renderActive()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!active || active.kind !== 'secret') return
    finish(secretInput.value)
  })
  cancelBtn.addEventListener('click', () => {
    finish('')
  })
  confirmApprove.addEventListener('click', () => {
    if (!active || active.kind !== 'confirm') return
    finish('yes')
  })
  confirmReject.addEventListener('click', () => {
    finish('')
  })

  api.sshPrompt.onRequest((req) => {
    if (active) queue.push(req)
    else {
      active = req
      renderActive()
    }
  })
}
