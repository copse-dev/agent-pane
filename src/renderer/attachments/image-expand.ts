import { el } from '../dom/helpers.ts'

let expandDialog: HTMLDialogElement | null = null
let imageEl: HTMLImageElement | null = null

function ensureExpandDialog(): HTMLDialogElement {
  if (expandDialog) return expandDialog

  expandDialog = document.createElement('dialog')
  expandDialog.className = 'image-expand-dialog'
  expandDialog.setAttribute('aria-label', 'Image preview')

  const body = el('div', { class: 'image-expand-dialog-body' })
  imageEl = el('img', {
    class: 'image-expand-image',
    alt: 'Expanded attachment',
  })
  body.append(imageEl)

  const closeBtn = el('button', { type: 'button', class: 'image-expand-close' }, 'Close')

  expandDialog.append(body, closeBtn)
  document.body.append(expandDialog)

  closeBtn.addEventListener('click', () => expandDialog?.close())
  expandDialog.addEventListener('click', (event) => {
    if (event.target === expandDialog) expandDialog?.close()
  })
  expandDialog.addEventListener('close', () => {
    if (imageEl) {
      imageEl.removeAttribute('src')
      imageEl.alt = 'Expanded attachment'
    }
  })

  return expandDialog
}

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(src: string, alt = 'Expanded attachment'): void {
  if (!src) return
  const dialog = ensureExpandDialog()
  if (!imageEl) return
  imageEl.src = src
  imageEl.alt = alt
  dialog.showModal()
}

/**
 * Wire click / keyboard expand on an attachment thumbnail. Idempotent via
 * `data-image-expand`. Callers should pass a live `src` (or ensure it lands
 * before the user clicks); empty src is a no-op open.
 */
export function attachImageExpand(img: HTMLImageElement, alt?: string): void {
  if (img.dataset['imageExpand'] === 'true') return
  img.dataset['imageExpand'] = 'true'
  img.classList.add('image-expandable')
  img.setAttribute('role', 'button')
  img.setAttribute('tabindex', '0')
  img.setAttribute('aria-label', alt ? `Expand ${alt}` : 'Expand image')

  const open = (): void => {
    const label = alt ?? (img.alt || 'Expanded attachment')
    openImageExpand(img.currentSrc || img.src, label)
  }

  img.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    open()
  })
  img.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    open()
  })
}
