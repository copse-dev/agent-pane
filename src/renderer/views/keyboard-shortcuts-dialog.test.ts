// Verifies the Cmd/Ctrl+/ keyboard-shortcut cheat sheet: it mounts as a native
// <dialog>, renders a labelled row per binding with per-key <kbd> chips, and
// opens/closes via the exported helpers.
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — same approach as the file-search and
// settings dialog tests. Real top-layer behaviour (focus trap, Esc-to-close) is
// covered by Chromium e2e.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mountKeyboardShortcutsDialog,
  openKeyboardShortcutsDialog,
  closeKeyboardShortcutsDialog,
  isKeyboardShortcutsDialogOpen,
} from './keyboard-shortcuts-dialog.ts'

function shimModal(dialog: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: () => void (open = true) },
    close: { configurable: true, value: () => void (open = false) },
    open: { configurable: true, get: () => open },
  })
}

describe('keyboard shortcuts dialog (Cmd/Ctrl+/)', () => {
  let dialog: HTMLDialogElement

  beforeEach(() => {
    document.body.innerHTML = ''
    mountKeyboardShortcutsDialog()
    dialog = document.getElementById('keyboard-shortcuts-dialog') as HTMLDialogElement
    shimModal(dialog)
  })

  it('mounts as a native dialog, initially closed', () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isKeyboardShortcutsDialogOpen(), false)
  })

  it('renders grouped sections with a labelled row per shortcut', () => {
    const groups = dialog.querySelectorAll('.keyboard-shortcuts-group')
    assert.ok(groups.length >= 3, 'expected General / Navigation / Panels groups')
    const rows = dialog.querySelectorAll('.keyboard-shortcuts-row')
    assert.ok(rows.length > 0)
    // Every row pairs a label with at least one <kbd> key chip.
    for (const row of rows) {
      assert.ok(row.querySelector('.keyboard-shortcuts-label')?.textContent)
      assert.ok(row.querySelectorAll('kbd.keyboard-shortcuts-key').length >= 1)
    }
    // The cheat sheet documents its own opener.
    const labels = [...dialog.querySelectorAll('.keyboard-shortcuts-label')].map(
      (n) => n.textContent,
    )
    assert.ok(labels.includes('Keyboard shortcuts'))
    assert.ok(labels.includes('New thread'))
  })

  it('opens and closes via the exported helpers', () => {
    openKeyboardShortcutsDialog()
    assert.equal(isKeyboardShortcutsDialogOpen(), true)
    // Opening again while already open is a no-op (no throw).
    openKeyboardShortcutsDialog()
    assert.equal(isKeyboardShortcutsDialogOpen(), true)
    closeKeyboardShortcutsDialog()
    assert.equal(isKeyboardShortcutsDialogOpen(), false)
  })

  it('close() is a no-op when already closed', () => {
    closeKeyboardShortcutsDialog()
    assert.equal(isKeyboardShortcutsDialogOpen(), false)
  })
})
