import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { el } from '../dom/helpers.ts'
import { CopseUiActions, uiActions } from './actions.ts'

describe('uiActions', () => {
  it('creates a light-DOM copse-ui-actions host', () => {
    const row = uiActions(
      el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Cancel'),
      el('button', { type: 'button', class: 'ui-btn ui-btn-primary' }, 'OK'),
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
