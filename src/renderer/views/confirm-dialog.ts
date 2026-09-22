import { el, qs } from '../dom/helpers.ts'
import { uiActions } from '../ui/index.ts'

export interface ConfirmDialogRequest {
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (delete, restore, etc.). */
  danger?: boolean
  /**
   * Run confirmed work while the dialog stays open with disabled controls.
   * The progress callback updates the primary label for long-running actions.
   */
  onConfirm?: (setProgressLabel: (label: string) => void) => Promise<void>
  confirmPendingLabel?: string
}

interface QueuedConfirm extends ConfirmDialogRequest {
  resolve: (confirmed: boolean) => void
  reject: (reason: unknown) => void
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
  const buttonsEl = uiActions({ className: 'confirm-dialog-buttons' })
  const dialog = el('dialog', { id: 'confirm-dialog' }, messageEl, detailEl, buttonsEl)
  document.body.append(dialog)

  const queue: QueuedConfirm[] = []
  let active: QueuedConfirm | null = null
  let confirming = false

  function finish(confirmed: boolean): void {
    if (!active) return
    const resolve = active.resolve
    active = null
    confirming = false
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
    // Kit value for buttons is the shared `.ui-btn*` CSS, not a factory wrapper.
    const cancelBtn = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary confirm-dialog-cancel' },
      cancelLabel,
    )
    const confirmBtn = el(
      'button',
      {
        type: 'button',
        class: active.danger
          ? 'ui-btn ui-btn-danger confirm-dialog-confirm'
          : 'ui-btn ui-btn-primary confirm-dialog-confirm',
      },
      confirmLabel,
    )
    cancelBtn.addEventListener('click', () => {
      finish(false)
    })
    async function confirmActive(): Promise<void> {
      if (!active || confirming) return
      const request = active
      if (!request.onConfirm) {
        finish(true)
        return
      }
      confirming = true
      cancelBtn.disabled = true
      confirmBtn.disabled = true
      confirmBtn.setAttribute('aria-busy', 'true')
      confirmBtn.textContent = request.confirmPendingLabel ?? `${confirmLabel}…`
      try {
        await request.onConfirm((label) => {
          if (active === request) confirmBtn.textContent = label
        })
        if (active === request) finish(true)
      } catch (error) {
        if (active !== request) return
        const reject = request.reject
        active = null
        confirming = false
        dialog.close()
        reject(error)
        if (queue.length > 0) {
          active = queue.shift() ?? null
          renderActive()
        }
      }
    }
    confirmBtn.addEventListener('click', () => {
      void confirmActive()
    })
    buttonsEl.replaceChildren(cancelBtn, confirmBtn)

    dialog.showModal()
    confirmBtn.focus()
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    if (confirming) return
    finish(false)
  })

  showConfirmDialogImpl = (req: ConfirmDialogRequest): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const queued: QueuedConfirm = { ...req, resolve, reject }
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
