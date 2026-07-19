import { el, qs } from '../dom/helpers.ts'

export interface ConfirmDialogRequest {
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (delete, restore, etc.). */
  danger?: boolean
}

interface QueuedConfirm extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void
}

/**
 * In-app yes/no prompts for renderer-initiated destructive or sensitive actions.
 * Replaces `window.confirm`, which renders as a native Chromium dialog in Electron.
 */
export function mountConfirmDialog(): void {
  document.getElementById('confirm-dialog')?.remove()
  showConfirmDialogImpl = null

  const messageEl = el('h3', { class: 'confirm-dialog-message' })
  const detailEl = el('p', { class: 'confirm-dialog-detail' })
  const buttonsEl = el('div', { class: 'confirm-dialog-buttons' })
  const dialog = el('dialog', { id: 'confirm-dialog' }, messageEl, detailEl, buttonsEl)
  document.body.append(dialog)

  const queue: QueuedConfirm[] = []
  let active: QueuedConfirm | null = null

  function finish(confirmed: boolean): void {
    if (!active) return
    const resolve = active.resolve
    active = null
    dialog.close()
    resolve(confirmed)
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

    const cancelLabel = active.cancelLabel ?? 'Cancel'
    const confirmLabel = active.confirmLabel ?? 'OK'
    const cancelBtn = el(
      'button',
      { type: 'button', class: 'confirm-dialog-cancel' },
      cancelLabel,
    )
    const confirmBtn = el(
      'button',
      {
        type: 'button',
        class: active.danger ? 'confirm-dialog-confirm confirm-dialog-danger' : 'confirm-dialog-confirm',
      },
      confirmLabel,
    )
    cancelBtn.addEventListener('click', () => {
      finish(false)
    })
    confirmBtn.addEventListener('click', () => {
      finish(true)
    })
    buttonsEl.replaceChildren(cancelBtn, confirmBtn)

    dialog.showModal()
    confirmBtn.focus()
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    finish(false)
  })

  showConfirmDialogImpl = (req: ConfirmDialogRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const queued: QueuedConfirm = { ...req, resolve }
      if (active) queue.push(queued)
      else {
        active = queued
        renderActive()
      }
    })
}

let showConfirmDialogImpl: ((req: ConfirmDialogRequest) => Promise<boolean>) | null = null

export function showConfirmDialog(req: ConfirmDialogRequest): Promise<boolean> {
  if (!showConfirmDialogImpl) return Promise.resolve(false)
  return showConfirmDialogImpl(req)
}

/** Test helper: click the active confirm dialog's primary button. */
export function clickActiveConfirmDialogConfirm(): void {
  qs<HTMLButtonElement>(document, '#confirm-dialog .confirm-dialog-confirm')?.click()
}

/** Test helper: click the active confirm dialog's cancel button. */
export function clickActiveConfirmDialogCancel(): void {
  qs<HTMLButtonElement>(document, '#confirm-dialog .confirm-dialog-cancel')?.click()
}
