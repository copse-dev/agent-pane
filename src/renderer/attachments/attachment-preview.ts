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
}

let dialog: HTMLDialogElement | null = null
let titleEl: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let currentCleanup: (() => void) | null = null
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
  const closeBtn = el('button', { type: 'button', class: 'attachment-preview-close' }, 'Close')
  dialog.append(titleEl, bodyEl, closeBtn)
  document.body.append(dialog)

  closeBtn.addEventListener('click', () => dialog?.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog?.close()
  })
  // Escape, the close button, backdrop clicks, and programmatic replacement all
  // converge here so a future media preview cannot leak resources.
  dialog.addEventListener('close', () => {
    activeToken += 1
    releaseCurrent()
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
  if (!previewDialog.open) previewDialog.showModal()

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
