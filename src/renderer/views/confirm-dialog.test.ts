import '../../../tests/setup-dom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
  showConfirmDialog,
} from './confirm-dialog.ts'
import { qsRequired } from '../dom/helpers.ts'

afterEach((): void => {
  document.getElementById('confirm-dialog')?.remove()
})

describe('confirm-dialog', () => {
  it('resolves true when the confirm button is clicked', async () => {
    mountConfirmDialog()
    const pending = showConfirmDialog({
      message: 'Delete roadmap item "Ship it"?',
      confirmLabel: 'Delete',
      danger: true,
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '#confirm-dialog')
    assert.ok(dialog.open)
    clickActiveConfirmDialogConfirm()
    assert.equal(await pending, true)
    assert.equal(dialog.open, false)
  })

  it('resolves false when the cancel button is clicked', async () => {
    mountConfirmDialog()
    const pending = showConfirmDialog({ message: 'Delete this thread?' })
    clickActiveConfirmDialogCancel()
    assert.equal(await pending, false)
  })
})
