import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createOverlayDialog, isAnyDialogOpen } from './dialog-shell.ts'

describe('createOverlayDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('appends a native <dialog> to the body with the given id and class', () => {
    const shell = createOverlayDialog({ id: 'test-overlay', className: 'settings-overlay' })
    assert.equal(shell.dialog.tagName, 'DIALOG')
    assert.equal(shell.dialog.parentElement, document.body)
    assert.equal(shell.dialog.id, 'test-overlay')
    assert.equal(shell.dialog.className, 'settings-overlay')
    assert.equal(shell.isOpen(), false)
  })

  it('open() shows modally, close() closes, both idempotent', () => {
    const shell = createOverlayDialog({ id: 'test-overlay' })
    shell.open()
    assert.equal(shell.isOpen(), true)
    // A second open() must not throw (showModal on an open dialog would).
    shell.open()
    assert.equal(shell.isOpen(), true)
    shell.close()
    assert.equal(shell.isOpen(), false)
    shell.close()
    assert.equal(shell.isOpen(), false)
  })

  it('close() funnels through the native close event (the cleanup hook)', () => {
    const shell = createOverlayDialog({ id: 'test-overlay' })
    let closes = 0
    shell.dialog.addEventListener('close', () => {
      closes += 1
    })
    shell.open()
    shell.close()
    assert.equal(closes, 1)
    // Closing while already closed must not re-fire cleanup.
    shell.close()
    assert.equal(closes, 1)
  })
})

describe('isAnyDialogOpen', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is false with no dialogs, and false when one exists but is closed', () => {
    assert.equal(isAnyDialogOpen(), false)
    createOverlayDialog({ id: 'closed-overlay' })
    assert.equal(isAnyDialogOpen(), false)
  })

  it('is true while a modal dialog is open, and false again once it closes', () => {
    const shell = createOverlayDialog({ id: 'modal-overlay' })
    shell.open()
    assert.equal(isAnyDialogOpen(), true)
    shell.close()
    assert.equal(isAnyDialogOpen(), false)
  })

  it('counts a non-modal dialog too', () => {
    // The approval prompt shows inline over the chat with `show()`, not
    // `showModal()`. It is still a question the user is answering, so a global
    // shortcut must not act on the transcript behind it.
    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    dialog.show()
    assert.equal(isAnyDialogOpen(), true)
    dialog.close()
    assert.equal(isAnyDialogOpen(), false)
  })

  it('stays true while any one of several dialogs is still open', () => {
    const first = createOverlayDialog({ id: 'first-overlay' })
    const second = createOverlayDialog({ id: 'second-overlay' })
    first.open()
    second.open()
    first.close()
    assert.equal(isAnyDialogOpen(), true, 'the second dialog is still on screen')
    second.close()
    assert.equal(isAnyDialogOpen(), false)
  })

  it('does not need to know the dialog exists', () => {
    // The point of reading the DOM: a dialog built anywhere, by anything, is
    // covered without being registered (#2474).
    document.body.insertAdjacentHTML('beforeend', '<dialog open id="ad-hoc"></dialog>')
    assert.equal(isAnyDialogOpen(), true)
  })
})
