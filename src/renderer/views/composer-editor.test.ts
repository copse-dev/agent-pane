import '../../../tests/setup-dom.ts'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHIP_CHAR, mountComposerEditor } from './composer-editor.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'

// Selection-dependent behavior (insert at caret, selectionStart mapping) needs
// a real focused Chromium selection and is exercised by the paste e2e spec;
// these tests cover the unfocused/document paths: serialization, chip↔slot
// re-binding on `value` writes, block pruning, and fenced expansion.

describe('composer editor value serialization', () => {
  it('round-trips plain text and reads chips as CHIP_CHAR', () => {
    const editor = mountComposerEditor()
    editor.value = 'hello\nworld'
    assert.equal(editor.value, 'hello\nworld')

    editor.insertPasteChip('pasted body\nsecond line')
    assert.equal(editor.value, `hello\nworld${CHIP_CHAR}`)
    assert.equal(editor.getBlocks().length, 1)
    assert.equal(editor.getBlocks()[0]?.label, 'pasted body')
  })

  it('re-binds existing chips to CHIP_CHAR slots when value is rewritten', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('block content')
    // A picker-style edit: slice the value and reassemble around the chip.
    editor.value = `before ${CHIP_CHAR} after`
    assert.equal(editor.value, `before ${CHIP_CHAR} after`)
    assert.equal(editor.getBlocks().length, 1)
    assert.equal(editor.getBlocks()[0]?.content, 'block content')
  })

  it('drops CHIP_CHARs that have no chip behind them (restored drafts)', () => {
    const editor = mountComposerEditor()
    editor.value = `orphan ${CHIP_CHAR} token`
    assert.equal(editor.value, 'orphan  token')
    assert.equal(editor.getBlocks().length, 0)
  })

  it('drops the block when its chip is removed via the close button', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('to be removed')
    const remove = editor.el.querySelector<HTMLButtonElement>('button.inline-paste-chip-remove')
    assert.ok(remove)
    assert.ok(remove.querySelector('svg[data-icon="close"]'))
    assert.equal(remove.textContent, '')
    remove.click()
    assert.equal(editor.value, '')
    assert.equal(editor.getBlocks().length, 0)
  })

  it('clears text and blocks together', () => {
    const editor = mountComposerEditor()
    editor.value = 'text'
    editor.insertPasteChip('block')
    editor.clear()
    assert.equal(editor.value, '')
    assert.equal(editor.getBlocks().length, 0)
  })
})

describe('composer editor expandedValue', () => {
  it('expands a chip into a fenced block at its position', () => {
    const editor = mountComposerEditor()
    editor.value = 'The editor points:'
    editor.insertPasteChip('- tighten intro\n- fix typos')
    const expanded = editor.expandedValue()
    assert.match(expanded, /^The editor points:/)
    assert.match(expanded, /```\n\/\/ - tighten intro\n- tighten intro\n- fix typos\n```/)
  })

  it('keeps blank-line separation between text and the fence on both sides', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('block body')
    editor.value = `before${CHIP_CHAR}after`
    const expanded = editor.expandedValue()
    assert.equal(expanded, 'before\n\n```\n// block body\nblock body\n```\n\nafter')
  })

  it('uses an explicit label when one is provided', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('const x = 1', 'main.ts:1')
    assert.match(editor.expandedValue(), /```\n\/\/ main\.ts:1\nconst x = 1\n```/)
  })

  it('returns plain text unchanged when there are no chips', () => {
    const editor = mountComposerEditor()
    editor.value = 'just text\nwith lines'
    assert.equal(editor.expandedValue(), 'just text\nwith lines')
  })
})

describe('composer editor chip preview', () => {
  before(patchPreviewDialog)

  it('opens the pasted body in the attachment modal before the prompt is sent', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('- tighten intro\n- fix typos', 'review notes')

    const label = editor.el.querySelector<HTMLElement>('.inline-paste-chip-label')
    assert.ok(label)
    assert.equal(label.getAttribute('role'), 'button')
    assert.equal(label.getAttribute('aria-label'), 'Preview review notes')
    label.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

    const dialog = document.querySelector<HTMLDialogElement>('.attachment-preview-dialog')
    assert.ok(dialog)
    assert.equal(dialog.open, true)
    assert.equal(
      dialog.querySelector('.attachment-preview-text')?.textContent,
      '- tighten intro\n- fix typos',
    )
    dialog.close()
  })

  /**
   * The affordance rides the label, not the pill: the pill's close icon is a real button,
   * and the editor treats the whole chip as one atomic character. Opening a
   * preview must not consume the click that removes the chip, nor change how
   * the chip serializes.
   */
  it('leaves the chip atomic and its close button working', () => {
    const editor = mountComposerEditor()
    editor.insertPasteChip('block body')
    assert.equal(editor.value, CHIP_CHAR)

    const remove = editor.el.querySelector<HTMLButtonElement>('button.inline-paste-chip-remove')
    assert.ok(remove)
    remove.click()
    assert.equal(editor.value, '')
    assert.equal(editor.getBlocks().length, 0)
    assert.equal(
      document.querySelector<HTMLDialogElement>('.attachment-preview-dialog')?.open ?? false,
      false,
      'removing a chip does not open its preview',
    )
  })
})
