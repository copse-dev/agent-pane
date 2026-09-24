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
    assert.equal(dialog.querySelector('copse-ui-actions')?.classList.contains('ui-actions'), true)
    const confirm = dialog.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')
    assert.ok(confirm?.classList.contains('ui-btn'))
    assert.ok(confirm?.classList.contains('ui-btn-danger'))
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

  it('keeps async confirmed work visible and reports progress until it settles', async () => {
    mountConfirmDialog()
    let finish: () => void = () => {
      throw new Error('confirmation did not start')
    }
    const pending = showConfirmDialog({
      message: 'Clean selected worktrees?',
      confirmLabel: 'Clean up',
      confirmPendingLabel: 'Cleanup pending…',
      onConfirm: async (setProgressLabel) => {
        setProgressLabel('Cleaning 1 of 2…')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '#confirm-dialog')
    clickActiveConfirmDialogConfirm()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const confirm = qsRequired<HTMLButtonElement>(dialog, '.confirm-dialog-confirm')
    const cancel = qsRequired<HTMLButtonElement>(dialog, '.confirm-dialog-cancel')
    assert.equal(dialog.open, true)
    assert.equal(confirm.textContent, 'Cleaning 1 of 2…')
    assert.equal(confirm.disabled, true)
    assert.equal(confirm.getAttribute('aria-busy'), 'true')
    assert.equal(cancel.disabled, true)

    finish()
    assert.equal(await pending, true)
    assert.equal(dialog.open, false)
  })
})
