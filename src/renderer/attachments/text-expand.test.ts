import '../../../tests/setup-dom.ts'
import { before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { qs, qsRequired } from '../dom/helpers.ts'
import { attachTextExpand, openTextExpand } from './text-expand.ts'
import { patchPreviewDialog } from './preview-dialog.test-support.ts'

function rightClick(target: EventTarget): void {
  target.dispatchEvent(
    new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 8,
      clientY: 16,
    }),
  )
}

/** Installs a `navigator.clipboard.writeText` stub that records every call. */
function installClipboard(): string[] {
  const writes: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (text: string): Promise<void> => {
          writes.push(text)
          return Promise.resolve()
        },
      },
    },
  })
  return writes
}

function tick(): Promise<void> {
  return Promise.resolve()
}

describe('text attachment preview', () => {
  before(patchPreviewDialog)
  beforeEach(() => {
    dismissContextMenu()
  })

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

  it('right-click with no selection offers "Copy" and copies the whole file', async () => {
    const writes = installClipboard()
    openTextExpand('line one\nline two', 'notes.txt')
    const preview = qsRequired(document, '.attachment-preview-text')

    rightClick(preview)
    const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
    assert.equal(item.textContent, 'Copy')

    item.click()
    await tick()

    assert.deepEqual(writes, ['line one\nline two'])
  })

  it('right-click with an active selection copies just the selected text', async () => {
    const writes = installClipboard()
    openTextExpand('line one\nline two', 'notes.txt')
    const preview = qsRequired(document, '.attachment-preview-text')

    const range = document.createRange()
    range.selectNodeContents(preview)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    rightClick(preview)
    const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
    assert.equal(item.textContent, 'Copy selection')

    item.click()
    await tick()

    assert.deepEqual(writes, ['line one\nline two'])
  })

  it('ignores an active selection outside the preview and copies the whole file', async () => {
    const writes = installClipboard()
    const outside = document.createElement('p')
    outside.textContent = 'unrelated selected text'
    document.body.append(outside)
    openTextExpand('line one\nline two', 'notes.txt')
    const preview = qsRequired(document, '.attachment-preview-text')

    const range = document.createRange()
    range.selectNodeContents(outside)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    rightClick(preview)
    const item = qsRequired<HTMLButtonElement>(document, '.context-menu-item')
    assert.equal(item.textContent, 'Copy')

    item.click()
    await tick()

    assert.deepEqual(writes, ['line one\nline two'])
    outside.remove()
  })

  it('does not open a menu when right-clicking outside the preview', () => {
    installClipboard()
    openTextExpand('content', 'notes.txt')
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')

    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    dialog.dispatchEvent(event)

    assert.equal(event.defaultPrevented, false)
    assert.equal(qs(document, '.context-menu'), null)
  })
})
