import '../../../tests/setup-dom.ts'
import { before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qsRequired } from '../dom/helpers.ts'
import { openAttachmentPreview } from './attachment-preview.ts'
import { patchPreviewDialog } from './preview-dialog.test-support.ts'

describe('attachment preview shell', () => {
  before(() => {
    patchPreviewDialog()
  })

  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('keeps Escape inside the modal without suppressing native cancellation', async () => {
    openAttachmentPreview({
      kind: 'test',
      title: 'Preview',
      content: document.createElement('div'),
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    let documentSawEscape = false
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      documentSawEscape = true
      event.preventDefault()
    }
    document.addEventListener('keydown', onKeydown)

    const escape = new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(escape)
    document.removeEventListener('keydown', onKeydown)

    assert.equal(documentSawEscape, false)
    assert.equal(escape.defaultPrevented, false)
    dialog.close()
    await Promise.resolve()
  })

  it('does not restore stale focus when another preview opens before the microtask', async () => {
    const first = document.createElement('button')
    const second = document.createElement('button')
    document.body.append(first, second)
    let staleResolverCalled = false

    first.focus()
    openAttachmentPreview({
      kind: 'test',
      title: 'First',
      content: document.createElement('div'),
      returnFocus: () => {
        staleResolverCalled = true
        return first
      },
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    dialog.close()

    second.focus()
    openAttachmentPreview({
      kind: 'test',
      title: 'Second',
      content: document.createElement('div'),
      returnFocus: () => second,
    })
    await Promise.resolve()

    assert.equal(staleResolverCalled, false)
    assert.equal(dialog.open, true)
    assert.notEqual(document.activeElement, first)

    dialog.close()
    await Promise.resolve()
    assert.equal(document.activeElement, second)
  })
})
