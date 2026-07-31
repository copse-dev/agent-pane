import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { el } from '../dom/helpers.ts'
import { CopseUiField, uiField } from './field.ts'

describe('uiField', () => {
  it('assembles label, control, and hint in a light-DOM custom element', () => {
    const select = el('select', { name: 'coder' })
    const field = uiField({
      label: 'Coder',
      control: select,
      hint: 'Main local model',
    })
    assert.ok(field instanceof CopseUiField)
    assert.equal(field.tagName, 'COPSE-UI-FIELD')
    assert.equal(field.querySelector('.ui-field-label')?.textContent, 'Coder')
    assert.equal(field.querySelector('select'), select)
    assert.equal(field.querySelector('.ui-field-hint')?.textContent, 'Main local model')
    assert.ok(field.querySelector('.ui-field-hint')?.classList.contains('field-hint'))
  })

  it('updates label/hint attributes after mount', () => {
    const field = uiField({ label: 'A', control: el('input', { type: 'text' }) })
    document.body.append(field)
    field.setAttribute('label', 'B')
    field.setAttribute('hint', 'Help')
    assert.equal(field.querySelector('.ui-field-label')?.textContent, 'B')
    assert.equal(field.querySelector('.ui-field-hint')?.textContent, 'Help')
    field.remove()
  })
})
