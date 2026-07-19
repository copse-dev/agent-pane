import { el, qs } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { showToast } from './toast.ts'

interface UpdatePromptRequest {
  id: string
  message: string
  detail?: string
  buttons: string[]
  defaultIndex?: number
  cancelIndex?: number
}

/**
 * In-app prompts for auto-update download/install consent. Replaces Electron's
 * native `dialog.showMessageBox`, which looked out of place in the Copse UI.
 */
export function mountUpdatePromptDialog(api: ApiClient): void {
  const messageEl = el('h3', { class: 'update-prompt-message' })
  const detailEl = el('p', { class: 'update-prompt-detail' })
  const buttonsEl = el('div', { class: 'update-prompt-buttons' })
  const dialog = el('dialog', { id: 'update-prompt-dialog' }, messageEl, detailEl, buttonsEl)
  document.body.append(dialog)

  const queue: UpdatePromptRequest[] = []
  let active: UpdatePromptRequest | null = null

  function finish(buttonIndex: number): void {
    if (!active) return
    const id = active.id
    active = null
    dialog.close()
    void api.updatePrompt.respond(id, buttonIndex)
    if (queue.length > 0) {
      active = queue.shift() ?? null
      renderActive()
    }
  }

  function renderActive(): void {
    if (!active) return
    messageEl.textContent = active.message
    if (active.detail) {
      detailEl.textContent = active.detail
      detailEl.hidden = false
    } else {
      detailEl.textContent = ''
      detailEl.hidden = true
    }

    const defaultIndex = active.defaultIndex ?? 0
    buttonsEl.replaceChildren(
      ...active.buttons.map((label, index) => {
        const isPrimary = index === defaultIndex
        const button = el(
          'button',
          {
            type: 'button',
            class: isPrimary ? 'update-prompt-primary' : 'update-prompt-secondary',
          },
          label,
        )
        button.addEventListener('click', () => {
          finish(index)
        })
        return button
      }),
    )

    dialog.showModal()
    qs<HTMLButtonElement>(buttonsEl, '.update-prompt-primary')?.focus()
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    finish(active?.cancelIndex ?? (active ? active.buttons.length - 1 : -1))
  })

  api.updatePrompt.onRequest((req) => {
    if (active) queue.push(req)
    else {
      active = req
      renderActive()
    }
  })

  api.updatePrompt.onDevNotice(() => {
    showToast(
      'Updates apply to the packaged app — automatic updates are available in the signed, downloaded build of Copse.',
      { variant: 'info' },
    )
  })
}
