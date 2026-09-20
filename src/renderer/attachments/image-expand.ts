import { el } from '../dom/helpers.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(
  src: string,
  alt = 'Expanded attachment',
  returnFocus?: () => HTMLElement | null,
): void {
  if (!src) return
  const imageEl = el('img', { class: 'image-expand-image', alt })
  imageEl.src = src
  openAttachmentPreview({
    kind: 'image',
    title: alt,
    ariaLabel: `Image preview: ${alt}`,
    content: imageEl,
    ...(returnFocus ? { returnFocus } : {}),
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
    const src = img.currentSrc || img.src
    openImageExpand(src, label, () => {
      if (img.isConnected) return img
      // A live Changes/PR refresh replaces its image-diff nodes while the
      // modal is open. Recover the equivalent side rather than dropping focus
      // onto the page body when the original thumbnail no longer exists.
      for (const candidate of document.querySelectorAll<HTMLImageElement>('img.image-expandable')) {
        if (
          candidate.getAttribute('aria-label') === `Expand ${label}` &&
          (candidate.currentSrc || candidate.src) === src
        ) {
          return candidate
        }
      }
      return null
    })
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
