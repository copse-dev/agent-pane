import '../../../tests/setup-dom.ts'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachImageCopyMenu, attachImageExpand, openImageExpand } from './image-expand.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { qs, qsRequired } from '../dom/helpers.ts'
import { patchPreviewDialog } from './preview-dialog.test-support.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function mouseClick(target: EventTarget): void {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function rightClick(target: EventTarget): void {
  target.dispatchEvent(
    new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 24,
    }),
  )
}

/** Minimal `ClipboardItem` + `navigator.clipboard.write` stand-in; captures every write. */
function installClipboard(): { writes: Record<string, Blob>[] } {
  const state = { writes: [] as Record<string, Blob>[] }
  class FakeClipboardItem {
    items: Record<string, Blob>
    constructor(items: Record<string, Blob>) {
      this.items = items
    }
  }
  Object.assign(globalThis, { ClipboardItem: FakeClipboardItem })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        write: (items: FakeClipboardItem[]): Promise<void> => {
          for (const item of items) state.writes.push(item.items)
          return Promise.resolve()
        },
      },
    },
  })
  return state
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('image expand lightbox', () => {
  before(() => {
    patchPreviewDialog()
  })
  beforeEach(() => {
    dismissContextMenu()
  })

  it('wires expand affordances onto a thumbnail once', () => {
    const img = document.createElement('img')
    img.src = PNG
    attachImageExpand(img, 'shot.png')
    attachImageExpand(img, 'shot.png')

    assert.equal(img.dataset['imageExpand'], 'true')
    assert.equal(img.classList.contains('image-expandable'), true)
    assert.equal(img.getAttribute('role'), 'button')
    assert.equal(img.getAttribute('tabindex'), '0')
    assert.equal(img.getAttribute('aria-label'), 'Expand shot.png')
  })

  it('opens the dialog on click with the image src', () => {
    const img = document.createElement('img')
    img.src = PNG
    document.body.append(img)
    attachImageExpand(img, 'prompt-shot.png')
    mouseClick(img)

    const dialog = qsRequired(document, '.attachment-preview-dialog')
    const expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, PNG)
    assert.equal(expanded.alt, 'prompt-shot.png')
    assert.ok(qs(dialog, '.attachment-preview-close'))
  })

  it('opens on Enter/Space and ignores other keys', () => {
    const img = document.createElement('img')
    img.src = PNG
    attachImageExpand(img)
    img.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    assert.ok(qs(document, '.attachment-preview-dialog'))
    img.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  })

  it('openImageExpand is a no-op for an empty src', () => {
    const existing = qs<HTMLDialogElement>(document, '.attachment-preview-dialog')
    existing?.close()
    openImageExpand('')
    const dialog = qs<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog?.open ?? false, false)
  })

  it('Close and backdrop click dismiss the dialog', () => {
    openImageExpand(PNG, 'demo')
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog.open, true)

    qsRequired(dialog, '.attachment-preview-close').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    assert.equal(dialog.open, false)
    // The shared shell removes variant content on close, so neither pixels nor
    // a broken-image fallback can remain painted in a closed dialog.
    assert.equal(qs(dialog, '.image-expand-image'), null)

    openImageExpand(PNG)
    assert.equal(dialog.open, true)
    // Backdrop handler closes when the click target is the dialog itself.
    dialog.click()
    assert.equal(dialog.open, false)
  })

  it('right-click on a chat thumbnail copies its pixels without opening the preview', async () => {
    const clipboard = installClipboard()
    const img = document.createElement('img')
    img.src = PNG
    document.body.append(img)
    attachImageExpand(img, 'shot.png')

    rightClick(img)
    const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
    assert.equal(item.textContent, 'Copy image')
    assert.equal(
      qs<HTMLDialogElement>(document, '.attachment-preview-dialog')?.open ?? false,
      false,
    )

    item.click()
    await tick()

    assert.equal(clipboard.writes.length, 1)
    assert.equal(clipboard.writes[0]?.['image/png']?.type, 'image/png')
    img.remove()
  })

  it('copies a rendered SVG as PNG pixels', async () => {
    const clipboard = installClipboard()
    const img = document.createElement('img')
    img.src = 'data:image/svg+xml;base64,PHN2Zy8+'
    Object.defineProperties(img, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 2 },
      naturalHeight: { configurable: true, value: 3 },
    })
    const canvas = window.HTMLCanvasElement.prototype
    const getContext = Object.getOwnPropertyDescriptor(canvas, 'getContext')
    const toDataURL = Object.getOwnPropertyDescriptor(canvas, 'toDataURL')
    let drawnImage: HTMLImageElement | null = null
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: () => ({
        drawImage: (source: HTMLImageElement): void => {
          drawnImage = source
        },
      }),
    })
    Object.defineProperty(canvas, 'toDataURL', { configurable: true, value: () => PNG })

    try {
      attachImageCopyMenu(img)
      rightClick(img)
      const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
      assert.equal(item.textContent, 'Copy image')
      item.click()
      await tick()
      assert.equal(drawnImage, img)
      const blob = clipboard.writes[0]?.['image/png']
      assert.ok(blob instanceof Blob)
      assert.equal(blob.type, 'image/png')
      assert.ok(blob.size > 0)
    } finally {
      if (getContext) Object.defineProperty(canvas, 'getContext', getContext)
      if (toDataURL) Object.defineProperty(canvas, 'toDataURL', toDataURL)
    }
  })

  it('right-click offers "Copy image" and writes the image to the clipboard', async () => {
    const clipboard = installClipboard()
    openImageExpand(PNG, 'shot.png')
    const expanded = qsRequired<HTMLImageElement>(document, '.image-expand-image')

    rightClick(expanded)
    const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
    assert.equal(item.textContent, 'Copy image')

    item.click()
    await tick()

    assert.equal(clipboard.writes.length, 1)
    const write = clipboard.writes[0]
    assert.ok(write)
    const blob = write['image/png']
    assert.ok(blob instanceof Blob)
    assert.equal(blob.type, 'image/png')
  })

  it('does not suppress the default menu when right-clicking outside the image', () => {
    installClipboard()
    openImageExpand(PNG, 'shot.png')
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')

    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    dialog.dispatchEvent(event)

    assert.equal(event.defaultPrevented, false)
    assert.equal(qs(document, '.context-menu'), null)
  })
})
