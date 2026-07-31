import { el } from '../dom/helpers.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(src: string, alt = 'Expanded attachment'): void {
  if (!src) return
  const imageEl = el('img', { class: 'image-expand-image', alt })
  imageEl.src = src
  openAttachmentPreview({
    kind: 'image',
    title: alt,
    ariaLabel: `Image preview: ${alt}`,
    content: imageEl,
    onClose: () => {
      imageEl.removeAttribute('src')
      imageEl.alt = 'Expanded attachment'
    },
  })
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
