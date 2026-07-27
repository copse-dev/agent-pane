import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountModelPicker, mountModelSelectPicker } from './model-picker.ts'
import type { ModelOption } from './model-options.ts'

const OPTIONS: ModelOption[] = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Cloud models' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Cloud models' },
  { value: 'lmstudio:qwen', label: 'Qwen', group: 'Local models' },
]

describe('shared model picker', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('filters grouped options and selects from the searchable list', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let current = 'claude-sonnet-4-6'
    const picker = mountModelPicker(
      host,
      () => current,
      (value) => {
        current = value
      },
      async () => OPTIONS,
      { loadOnMount: false },
    )
    await picker.refresh()

    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    filter.value = 'opus'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    const matches = [...host.querySelectorAll<HTMLButtonElement>('.model-picker-option')]
    assert.deepEqual(
      matches.map((option) => option.textContent),
      ['Claude Opus 4.8'],
    )
    matches[0]?.click()

    assert.equal(current, 'claude-opus-4-8')
    assert.equal(host.querySelector('.model-picker-label')?.textContent, 'Claude Opus 4.8')
    assert.equal(host.querySelector('.model-picker-menu')?.hasAttribute('hidden'), true)
  })

  it('dismisses its own menu on Escape without bubbling to a parent dialog', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let escaped = false
    const onDocumentKeydown = (): void => {
      escaped = true
    }
    document.addEventListener('keydown', onDocumentKeydown)
    const picker = mountModelPicker(
      host,
      () => OPTIONS[0]?.value ?? '',
      () => {},
      async () => OPTIONS,
      {
        loadOnMount: false,
      },
    )
    await picker.refresh()

    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    assert.equal(escaped, false)
    assert.equal(host.querySelector('.model-picker-menu')?.hasAttribute('hidden'), true)
    document.removeEventListener('keydown', onDocumentKeydown)
    picker.destroy()
  })

  it('keeps a hidden select as form state and supports an automatic blank route', async () => {
    const form = document.createElement('form')
    const label = document.createElement('label')
    label.htmlFor = 'review-model'
    label.textContent = 'Review model'
    const select = document.createElement('select')
    select.id = 'review-model'
    select.name = 'reviewModel'
    form.append(label, select)
    document.body.append(form)

    let changes = 0
    select.addEventListener('change', () => {
      changes++
    })
    const picker = mountModelSelectPicker(select, {
      loadOptions: async () => [{ value: '', label: '(auto — prefer on-device)' }, ...OPTIONS],
      loadOnMount: false,
    })
    await picker.refresh('claude-sonnet-4-6')

    assert.equal(select.hidden, true)
    assert.equal(label.htmlFor, form.querySelector('.model-picker-trigger')?.id)
    assert.equal(new window.FormData(form).get('reviewModel'), 'claude-sonnet-4-6')
    form.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    form.querySelector<HTMLButtonElement>('.model-picker-option[data-value=""]')?.click()

    assert.equal(select.value, '')
    assert.equal(new window.FormData(form).get('reviewModel'), '')
    assert.equal(changes, 1)
    assert.equal(
      form.querySelector('.model-picker-label')?.textContent,
      '(auto — prefer on-device)',
    )
  })
})
