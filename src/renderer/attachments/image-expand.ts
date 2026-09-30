import { showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { arrowLeftIcon, arrowRightIcon, penLineIcon } from '../dom/icons.ts'
import { mountAnnotationLayer, type AnnotationLayer } from '../drawing/annotation-layer.ts'
import { attachAnnotation } from '../drawing/attach-annotation.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { openAttachmentPreview, type AttachmentPreviewSession } from './attachment-preview.ts'

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

export interface ImageExpandItem {
  src: string
  alt: string
}

function expandableImageSource(image: HTMLImageElement): string {
  const authoredSrc = image.getAttribute('src')
  const authoredSrcset = image.getAttribute('srcset')
  if (!authoredSrc?.trim() && !authoredSrcset?.trim()) return ''
  return image.currentSrc || image.src
}

function imageTitle(item: ImageExpandItem): string {
  return item.alt.trim() || 'Expanded attachment'
}

function annotatableImage(
  item: ImageExpandItem,
  closePreview: () => void,
): {
  frame: HTMLElement
  image: HTMLImageElement
  button: HTMLButtonElement
  deactivate: () => void
  dispose: () => void
} {
  const frame = el('div', { class: 'image-expand-frame' })
  const image = el('img', { class: 'image-expand-photo image-expand-image', alt: imageTitle(item) })
  image.src = item.src
  attachImageCopyMenu(image)
  const button = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost image-expand-annotate',
      'aria-label': `Annotate ${imageTitle(item)}`,
      'aria-pressed': 'false',
    },
    penLineIcon('ui-icon ui-icon-sm'),
    'Annotate',
  )
  let annotation: AnnotationLayer | null = null
  const captureBase = (): Promise<string | null> => {
    if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
      return Promise.resolve(null)
    }
    const { width, height } = frame.getBoundingClientRect()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width))
    canvas.height = Math.max(1, Math.round(height))
    const context = canvas.getContext('2d')
    if (!context) return Promise.resolve(null)
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    const drawnWidth = image.naturalWidth * scale
    const drawnHeight = image.naturalHeight * scale
    context.drawImage(
      image,
      (canvas.width - drawnWidth) / 2,
      (canvas.height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    )
    return Promise.resolve(canvas.toDataURL('image/png'))
  }
  button.addEventListener('click', () => {
    annotation ??= mountAnnotationLayer(frame, {
      label: imageTitle(item),
      captureBase,
      onSend: (payload): boolean => {
        const attached = attachAnnotation(payload, imageTitle(item))
        if (attached) closePreview()
        return attached
      },
      onDeactivate: (): void => {
        button.setAttribute('aria-pressed', 'false')
      },
    })
    button.setAttribute('aria-pressed', String(annotation.toggle()))
  })
  frame.append(image)
  return {
    frame,
    image,
    button,
    deactivate: (): void => annotation?.deactivate(),
    dispose: (): void => {
      annotation?.dispose()
      image.removeAttribute('src')
    },
  }
}

function openImageGalleryViewer(
  items: readonly ImageExpandItem[],
  initialIndex: number,
  returnFocus?: () => HTMLElement | null,
): void {
  let currentIndex = Math.min(Math.max(initialIndex, 0), items.length - 1)
  let session: AttachmentPreviewSession | null = null
  const viewer = el('div', {
    class: 'image-expand-viewer',
    role: 'group',
    'aria-roledescription': 'carousel',
    tabindex: '-1',
  })
  const stage = el('div', { class: 'image-expand-stage' })
  const images = items.map((item) => annotatableImage(item, () => session?.close()))

  const previousButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost image-expand-nav image-expand-nav-prev',
      'aria-label': 'Previous image',
    },
    arrowLeftIcon('ui-icon ui-icon-sm'),
  )
  const nextButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost image-expand-nav image-expand-nav-next',
      'aria-label': 'Next image',
    },
    arrowRightIcon('ui-icon ui-icon-sm'),
  )
  const previousZone = el(
    'div',
    { class: 'image-expand-nav-zone image-expand-nav-zone-prev' },
    previousButton,
  )
  const nextZone = el(
    'div',
    { class: 'image-expand-nav-zone image-expand-nav-zone-next' },
    nextButton,
  )
  stage.append(...images.map(({ frame }) => frame), previousZone, nextZone)

  const thumbnailButtons = items.map((item, index) => {
    const thumbnail = el('img', {
      class: 'image-expand-thumbnail-image',
      src: item.src,
      alt: '',
      loading: 'lazy',
    })
    const button = el(
      'button',
      {
        type: 'button',
        class: 'image-expand-thumbnail',
        'aria-label': 'Show image ' + String(index + 1) + ' of ' + String(items.length),
        'aria-selected': 'false',
        role: 'tab',
      },
      thumbnail,
    )
    button.addEventListener('click', () => {
      move(index)
    })
    return button
  })
  const thumbnailStrip = el(
    'div',
    { class: 'image-expand-thumbnails', role: 'tablist', 'aria-label': 'Attached images' },
    ...thumbnailButtons,
  )
  const counter = el('span', { class: 'image-expand-counter', 'aria-live': 'polite' })
  const actionSlot = el('div', { class: 'image-expand-gallery-action' })
  const footer = el('div', { class: 'image-expand-gallery-footer' }, thumbnailStrip, actionSlot)
  viewer.append(counter, stage, footer)

  const render = (): void => {
    const item = items[currentIndex]
    if (!item) return
    const label = imageTitle(item)
    for (const [index, entry] of images.entries()) {
      const selected = index === currentIndex
      entry.frame.hidden = !selected
      entry.image.classList.toggle('image-expand-image', selected)
    }
    const selectedImage = images[currentIndex]
    if (!selectedImage) return
    selectedImage.image.dataset['imageIndex'] = String(currentIndex)
    selectedImage.image.setAttribute(
      'aria-label',
      label + ', image ' + String(currentIndex + 1) + ' of ' + String(items.length),
    )
    actionSlot.replaceChildren(selectedImage.button)
    viewer.setAttribute(
      'aria-label',
      'Attached images, image ' + String(currentIndex + 1) + ' of ' + String(items.length),
    )
    counter.textContent = String(currentIndex + 1) + ' / ' + String(items.length)
    previousButton.disabled = currentIndex === 0
    nextButton.disabled = currentIndex === items.length - 1
    previousButton.setAttribute('aria-disabled', String(previousButton.disabled))
    nextButton.setAttribute('aria-disabled', String(nextButton.disabled))

    for (const [index, button] of thumbnailButtons.entries()) {
      const selected = index === currentIndex
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    }
    thumbnailButtons[currentIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const move = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= items.length || nextIndex === currentIndex) return
    images[currentIndex]?.deactivate()
    currentIndex = nextIndex
    render()
  }
  previousButton.addEventListener('click', () => {
    move(currentIndex - 1)
    viewer.focus({ preventScroll: true })
  })
  nextButton.addEventListener('click', () => {
    move(currentIndex + 1)
    viewer.focus({ preventScroll: true })
  })
  viewer.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      move(currentIndex - 1)
      viewer.focus({ preventScroll: true })
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      move(currentIndex + 1)
      viewer.focus({ preventScroll: true })
    }
  })

  render()
  const initialItem = items[currentIndex]
  if (!initialItem) return
  session = openAttachmentPreview({
    kind: 'image-gallery',
    title: 'Attached images · ' + String(items.length),
    ariaLabel: 'Image preview: ' + imageTitle(initialItem),
    content: viewer,
    ...(returnFocus ? { returnFocus } : {}),
    onClose: () => {
      for (const entry of images) entry.dispose()
      for (const button of thumbnailButtons) {
        button.querySelector('img')?.removeAttribute('src')
      }
    },
  })
  queueMicrotask(() => {
    if (session.isActive()) viewer.focus({ preventScroll: true })
  })
}

function openSingleImage(src: string, alt: string, returnFocus?: () => HTMLElement | null): void {
  let session: AttachmentPreviewSession | null = null
  const entry = annotatableImage({ src, alt }, () => session?.close())
  const content = el('div', { class: 'image-expand-single' }, entry.frame, entry.button)
  session = openAttachmentPreview({
    kind: 'image',
    title: alt,
    ariaLabel: 'Image preview: ' + alt,
    content,
    ...(returnFocus ? { returnFocus } : {}),
    onClose: () => {
      entry.dispose()
      entry.image.alt = 'Expanded attachment'
    },
  })
}

/** Open the shared image lightbox for a data URL (or other resolvable img src). */
export function openImageExpand(
  src: string,
  alt = 'Expanded attachment',
  returnFocus?: () => HTMLElement | null,
): void {
  if (!src) return
  openSingleImage(src, alt, returnFocus)
}

/** Open a navigable image gallery in the shared attachment lightbox. */
export function openImageGallery(
  items: readonly ImageExpandItem[],
  initialIndex = 0,
  returnFocus?: () => HTMLElement | null,
): void {
  const usableItems: ImageExpandItem[] = []
  let usableIndex = 0
  for (const [index, item] of items.entries()) {
    if (item.src.length === 0) continue
    if (index < initialIndex) usableIndex += 1
    usableItems.push(item)
  }
  if (usableItems.length === 0) return
  if (usableItems.length === 1) {
    const item = usableItems[0]
    if (item) openSingleImage(item.src, item.alt, returnFocus)
    return
  }
  openImageGalleryViewer(usableItems, usableIndex, returnFocus)
}

/**
 * Wire click / keyboard expand on an attachment thumbnail. Idempotent via
 * data-image-expand. Callers should pass a live src (or ensure it lands before
 * the user clicks); empty src is a no-op open.
 */
export function attachImageExpand(
  img: HTMLImageElement,
  alt?: string,
  gallery?: readonly ImageExpandItem[],
  galleryIndex?: number,
): void {
  if (img.dataset['imageExpand'] === 'true') return
  img.dataset['imageExpand'] = 'true'
  attachImageCopyMenu(img)
  img.classList.add('image-expandable')
  img.setAttribute('role', 'button')
  img.setAttribute('tabindex', '0')
  img.setAttribute('aria-label', alt ? 'Expand ' + alt : 'Expand image')

  const open = (): void => {
    const label = alt ?? (img.alt || 'Expanded attachment')
    const src = expandableImageSource(img)
    if (!src) return
    const focusTarget = (): HTMLElement | null => {
      if (img.isConnected) return img
      for (const candidate of document.querySelectorAll<HTMLImageElement>('img.image-expandable')) {
        if (
          candidate.getAttribute('aria-label') === 'Expand ' + label &&
          expandableImageSource(candidate) === src
        ) {
          return candidate
        }
      }
      return null
    }
    if (gallery && gallery.length > 1) {
      openImageGallery(gallery, galleryIndex ?? 0, focusTarget)
      return
    }
    openImageExpand(src, label, focusTarget)
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
