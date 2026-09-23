import { showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/**
 * Decode a `data:` URL into a Blob for the async Clipboard API. Every current
 * caller passes a data URL; decoding it directly (same idiom as the roadmap
 * composer's `dataUrlToText`) avoids routing it through `fetch`, which the
 * sandboxed main window's `file://` origin refuses for `data:` URLs.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Not a data URL')
  const header = dataUrl.slice(5, comma) // after "data:", before the comma
  const mime = header.split(';')[0] ?? ''
  const mimeType = mime === '' ? 'application/octet-stream' : mime
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mimeType })
}

async function copyImageToClipboard(src: string): Promise<void> {
  const blob = dataUrlToBlob(src)
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
}

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(src: string, alt = 'Expanded attachment'): void {
  if (!src) return
  const imageEl = el('img', { class: 'image-expand-image', alt })
  imageEl.src = src
  imageEl.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    showContextMenu(
      event.clientX,
      event.clientY,
      [
        {
          label: 'Copy image',
          onSelect: (): void => {
            void copyImageToClipboard(src)
              .then(() => showToast('Copied image', { durationMs: 1500 }))
              .catch((error: unknown) => {
                showErrorToast('Failed to copy image', error)
              })
          },
        },
      ],
      imageEl,
    )
  })
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
