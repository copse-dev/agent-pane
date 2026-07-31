import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qsRequired } from '../dom/helpers.ts'
import { attachTextExpand, openTextExpand } from './text-expand.ts'

function patchDialog(): void {
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = false
        this.dispatchEvent(new window.Event('close'))
      },
    },
  })
}

describe('text attachment preview', () => {
  before(patchDialog)

  it('renders arbitrary text literally in the shared attachment dialog', () => {
    openTextExpand('<script>not markup</script>\nsecond line', 'notes.txt')

    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    assert.equal(dialog.open, true)
    assert.equal(dialog.dataset['previewKind'], 'text')
    assert.equal(dialog.getAttribute('aria-label'), 'Text preview: notes.txt')
    assert.equal(qsRequired(dialog, '.attachment-preview-title').textContent, 'notes.txt')
    const preview = qsRequired(dialog, '.attachment-preview-text')
    assert.equal(preview.textContent, '<script>not markup</script>\nsecond line')
    assert.equal(preview.querySelector('script'), null)
    dialog.close()
  })

  it('wires click and keyboard affordances exactly once', () => {
    const chip = document.createElement('span')
    attachTextExpand(chip, 'snapshot', 'diff.txt')
    attachTextExpand(chip, 'snapshot', 'diff.txt')

    assert.equal(chip.dataset['textExpand'], 'true')
    assert.equal(chip.getAttribute('role'), 'button')
    assert.equal(chip.getAttribute('tabindex'), '0')
    assert.equal(chip.getAttribute('aria-label'), 'Preview diff.txt')
    chip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(qsRequired(document, '.attachment-preview-text').textContent, 'snapshot')
  })
})
