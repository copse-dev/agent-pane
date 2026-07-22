import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { uiButton } from './button.ts'

describe('uiButton', () => {
  it('builds a native button with kit variant classes', () => {
    const button = uiButton({
      label: 'Save',
      variant: 'primary',
      type: 'submit',
      className: 'extra-hook',
    })
    assert.equal(button.tagName, 'BUTTON')
    assert.equal(button.type, 'submit')
    assert.equal(button.textContent, 'Save')
    assert.equal(button.className, 'ui-btn ui-btn-primary extra-hook')
  })

  it('defaults to a secondary button type=button', () => {
    const button = uiButton({ label: 'Cancel' })
    assert.equal(button.type, 'button')
    assert.equal(button.className, 'ui-btn ui-btn-secondary')
  })
})
