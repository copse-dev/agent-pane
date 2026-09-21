import { showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/** Decode a base64 PNG directly without waiting for canvas encoding. */
function pngDataUrlToBlob(dataUrl: string): Blob {
  if (!/^data:image\/png;base64,/i.test(dataUrl)) throw new Error('Not a PNG data URL')
  const comma = dataUrl.indexOf(',')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: 'image/png' })
}

/** Convert a loaded SVG, JPEG, or other rendered format to clipboard PNG. */
function renderedImageToPng(image: HTMLImageElement): Blob {
  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error('Image has not loaded')
  }
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create image canvas')
  context.drawImage(image, 0, 0)
  return pngDataUrlToBlob(canvas.toDataURL('image/png'))
}

async function copyImageToClipboard(image: HTMLImageElement): Promise<void> {
  const src = image.currentSrc || image.src
  const png = /^data:image\/png;base64,/i.test(src)
    ? pngDataUrlToBlob(src)
    : renderedImageToPng(image)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** Add the same image menu to chat thumbnails, rendered artifacts, and previews. */
export function attachImageCopyMenu(image: HTMLImageElement): void {
  if (image.dataset['imageCopyMenu'] === 'true') return
  image.dataset['imageCopyMenu'] = 'true'
  image.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    showContextMenu(
      event.clientX,
      event.clientY,
      [
        {
          label: 'Copy image',
          onSelect: (): void => {
            void copyImageToClipboard(image)
              .then(() => showToast('Copied image', { durationMs: 1500 }))
              .catch((error: unknown) => {
                showErrorToast('Failed to copy image', error)
              })
          },
        },
      ],
      image,
    )
  })
}

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(
  src: string,
  alt = 'Expanded attachment',
  returnFocus?: () => HTMLElement | null,
): void {
  if (!src) return
  const imageEl = el('img', { class: 'image-expand-image', alt })
  imageEl.src = src
  attachImageCopyMenu(imageEl)
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
  attachImageCopyMenu(img)
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
