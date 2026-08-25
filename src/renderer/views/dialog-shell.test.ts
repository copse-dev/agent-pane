import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createOverlayDialog } from './dialog-shell.ts'

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
