import '../../../tests/setup-dom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { attachImageExpand, openImageExpand } from './image-expand.ts'
import { qs, qsRequired } from '../dom/helpers.ts'

// happy-dom doesn't implement <dialog> modality; stub showModal/close like mermaid-expand.
function patchEnv(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['showModal'] ??= function (this: HTMLElement): void {
    ;(this as unknown as { open: boolean }).open = true
  }
  proto['close'] ??= function (this: HTMLElement): void {
    ;(this as unknown as { open: boolean }).open = false
    this.dispatchEvent(new window.Event('close'))
  }
}

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function mouseClick(target: EventTarget): void {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('image expand lightbox', () => {
  before(() => {
    patchEnv()
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

    const dialog = qsRequired(document, '.image-expand-dialog')
    const expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, PNG)
    assert.equal(expanded.alt, 'prompt-shot.png')
    assert.ok(qs(dialog, '.image-expand-close'))
  })

  it('opens on Enter/Space and ignores other keys', () => {
    const img = document.createElement('img')
    img.src = PNG
    attachImageExpand(img)
    img.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    assert.ok(qs(document, '.image-expand-dialog'))
    img.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  })

  it('openImageExpand is a no-op for an empty src', () => {
    const existing = qs<HTMLDialogElement>(document, '.image-expand-dialog')
    existing?.close()
    openImageExpand('')
    const dialog = qs<HTMLDialogElement>(document, '.image-expand-dialog')
    assert.equal(dialog?.open ?? false, false)
  })

  it('Close and backdrop click dismiss the dialog', () => {
    openImageExpand(PNG, 'demo')
    const dialog = qsRequired<HTMLDialogElement>(document, '.image-expand-dialog')
    assert.equal(dialog.open, true)

    qsRequired(dialog, '.image-expand-close').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    assert.equal(dialog.open, false)
    // close handler clears src so a leaked open paint would show broken-image alt
    // ("Expanded attachment"). CSS must keep closed dialogs display:none.
    const expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.getAttribute('src'), null)
    assert.equal(expanded.alt, 'Expanded attachment')

    openImageExpand(PNG)
    assert.equal(dialog.open, true)
    // Backdrop handler closes when the click target is the dialog itself.
    dialog.click()
    assert.equal(dialog.open, false)
  })
})
