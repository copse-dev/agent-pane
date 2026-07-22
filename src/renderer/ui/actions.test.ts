import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CopseUiActions, uiActions } from './actions.ts'
import { uiButton } from './button.ts'

describe('uiActions', () => {
  it('creates a light-DOM copse-ui-actions host', () => {
    const row = uiActions(
      uiButton({ label: 'Cancel' }),
      uiButton({ label: 'OK', variant: 'primary' }),
      { className: 'confirm-dialog-buttons' },
    )
    assert.ok(row instanceof CopseUiActions)
    assert.equal(row.tagName, 'COPSE-UI-ACTIONS')
    assert.equal(row.dataset['align'], 'end')
    assert.ok(row.classList.contains('ui-actions'))
    assert.ok(row.classList.contains('confirm-dialog-buttons'))
    assert.equal(row.querySelectorAll('button').length, 2)
  })
})
