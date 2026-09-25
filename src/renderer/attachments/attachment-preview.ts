import { el } from '../dom/helpers.ts'

export interface AttachmentPreviewSession {
  /** True while this request still owns the shared dialog. */
  isActive(): boolean
  /** Replace the loading/error state with preview content. */
  setContent(content: Node): boolean
  /** Replace the preview content with a plain-text status or error. */
  setStatus(message: string): boolean
  close(): void
}

export interface AttachmentPreviewOptions {
  /** Stable, open-ended identifier used only for variant styling. */
  kind: string
  title: string
  ariaLabel?: string
  content?: Node
  status?: string
  /** Release resources such as media object URLs when replaced or closed. */
  onClose?: () => void
  /** Resolve the control that should regain focus after this modal closes. */
  returnFocus?: () => HTMLElement | null
}

let dialog: HTMLDialogElement | null = null
let titleEl: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let currentCleanup: (() => void) | null = null
let returnFocus: (() => HTMLElement | null) | null = null
let activeToken = 0

function releaseCurrent(): void {
  const cleanup = currentCleanup
  currentCleanup = null
  cleanup?.()
  bodyEl?.replaceChildren()
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) {
    // Component tests and app remounts can replace body children without
    // reloading this module. Reattach the singleton in a clean closed state.
    if (!dialog.isConnected) {
      if (dialog.open) dialog.close()
      document.body.append(dialog)
    }
    return dialog
  }

  dialog = document.createElement('dialog')
  dialog.className = 'attachment-preview-dialog'

  titleEl = el('div', { class: 'attachment-preview-title' })
  bodyEl = el('div', { class: 'attachment-preview-body' })
  const closeBtn = el(
    'button',
    { type: 'button', class: 'attachment-preview-close', 'aria-label': 'Close' },
    '×',
  )
  const header = el('div', { class: 'attachment-preview-header' }, titleEl, closeBtn)
  dialog.append(header, bodyEl)
  document.body.append(dialog)

  closeBtn.addEventListener('click', () => dialog?.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog?.close()
  })
  dialog.addEventListener('keydown', (event) => {
    // Keep the app-level agent-stop shortcut from cancelling native dialog
    // dismissal. Do not preventDefault: the browser must still emit `cancel`
    // and close the modal for Escape.
    if (event.key === 'Escape') event.stopPropagation()
  })
  // Escape, the close button, backdrop clicks, and programmatic replacement all
  // converge here so a future media preview cannot leak resources.
  dialog.addEventListener('close', () => {
    const resolveFocusTarget = returnFocus
    returnFocus = null
    activeToken += 1
    const closedToken = activeToken
    releaseCurrent()
    // Native dialog focus restoration finishes after the close event on some
    // Chromium versions. Run after that step so it cannot overwrite the
    // adapter's replacement-aware target (Changes can refresh while open).
    queueMicrotask(() => {
      if (activeToken !== closedToken || dialog?.open) return
      const focusTarget = resolveFocusTarget?.()
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true })
    })
  })

  return dialog
}

function statusNode(message: string): HTMLElement {
  return el('p', { class: 'attachment-preview-status' }, message)
}

/**
 * Open the single shared attachment viewer.
 *
 * The session API deliberately knows nothing about images, text, video, or
 * future file types. A renderer supplies a node immediately or swaps one in
 * after async loading; stale sessions cannot overwrite a later preview.
 */
export function openAttachmentPreview(options: AttachmentPreviewOptions): AttachmentPreviewSession {
  const previewDialog = ensureDialog()
  const previewBody = bodyEl
  const previewTitle = titleEl
  if (!previewBody || !previewTitle) throw new Error('Attachment preview dialog failed to mount')

  activeToken += 1
  const token = activeToken
  releaseCurrent()
  currentCleanup = options.onClose ?? null

  previewDialog.dataset['previewKind'] = options.kind
  previewDialog.setAttribute(
    'aria-label',
    options.ariaLabel ?? `Attachment preview: ${options.title}`,
  )
  previewTitle.textContent = options.title
  if (options.content) previewBody.replaceChildren(options.content)
  else previewBody.replaceChildren(statusNode(options.status ?? `Loading ${options.title}…`))
  if (!previewDialog.open) {
    const activeElement = document.activeElement
    const defaultReturnFocus = (): HTMLElement | null =>
      activeElement instanceof HTMLElement && activeElement.isConnected ? activeElement : null
    returnFocus = options.returnFocus ?? defaultReturnFocus
    previewDialog.showModal()
  }

  const isActive = (): boolean => token === activeToken && previewDialog.open
  return {
    isActive,
    setContent(content): boolean {
      if (!isActive()) return false
      previewBody.replaceChildren(content)
      return true
    },
    setStatus(message): boolean {
      if (!isActive()) return false
      previewBody.replaceChildren(statusNode(message))
      return true
    },
    close(): void {
      if (isActive()) previewDialog.close()
    },
  }
}
