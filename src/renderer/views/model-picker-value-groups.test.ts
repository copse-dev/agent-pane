import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { mountModelPicker, type PickerValueGroup } from './model-picker.ts'
import type { ModelOption } from './model-options.ts'

/**
 * The composer picker's second tier: selectors that belong to the *chosen model*
 * rather than to the catalog — an ACP agent's reasoning level and mode. They are
 * listed under the models, drill into their own choices, and are reachable from
 * the trigger's right-click menu without opening the model list at all.
 */

const MODELS: ModelOption[] = [
  { value: 'acp:claude', label: 'Claude Code' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet' },
]

function groups(): PickerValueGroup[] {
  return [
    {
      id: 'thinking',
      label: 'Thinking effort',
      currentValue: 'medium',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High', description: 'Think hard' },
      ],
    },
  ]
}

interface Mounted {
  host: HTMLElement
  picks: Array<[string, string]>
  trigger: HTMLButtonElement
  rows: () => HTMLButtonElement[]
  options: () => HTMLButtonElement[]
}

async function mount(valueGroups: PickerValueGroup[] = groups()): Promise<Mounted> {
  const host = document.createElement('div')
  document.body.append(host)
  const picks: Array<[string, string]> = []
  const picker = mountModelPicker(
    host,
    () => 'acp:claude',
    () => {},
    () => Promise.resolve(MODELS),
    {
      loadValueGroups: () => Promise.resolve(valueGroups),
      onSelectGroupValue: (groupId, value) => {
        picks.push([groupId, value])
      },
    },
  )
  await picker.refresh()
  const trigger = host.querySelector<HTMLButtonElement>('.model-picker-trigger')
  assert.ok(trigger)
  return {
    host,
    picks,
    trigger,
    rows: () => [...host.querySelectorAll<HTMLButtonElement>('.model-picker-group-row')],
    options: () => [...host.querySelectorAll<HTMLButtonElement>('.model-picker-option')],
  }
}

afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
})

describe('model picker value groups', () => {
  it('lists the current model’s selectors with their current value', async () => {
    const { trigger, rows } = await mount()
    trigger.click()

    const row = rows()[0]
    assert.equal(
      row?.querySelector('.model-picker-group-row-label')?.textContent,
      'Thinking effort',
    )
    assert.equal(row.querySelector('.model-picker-group-row-value')?.textContent, 'Medium')
  })

  it('shows no section when the model has no selectors', async () => {
    const { trigger, rows, host } = await mount([])
    trigger.click()

    assert.equal(rows().length, 0)
    assert.equal(host.querySelector<HTMLElement>('.model-picker-groups')?.hidden, true)
  })

  it('drills into a selector, marks the current value, and reports the pick', async () => {
    const { trigger, rows, options, picks } = await mount()
    trigger.click()
    rows()[0]?.click()

    const choices = options()
    assert.deepEqual(
      choices.map((choice) => choice.textContent.replace(/\s+$/, '')),
      ['Low', 'Medium', 'High'],
    )
    assert.equal(choices[1]?.getAttribute('aria-current'), 'true')

    choices[2]?.click()
    assert.deepEqual(picks, [['thinking', 'high']])
  })

  it('closes the menu after a pick and reflects the new value on the row', async () => {
    const { trigger, rows, options, host } = await mount()
    trigger.click()
    rows()[0]?.click()
    options()[0]?.click()

    assert.equal(host.querySelector<HTMLElement>('.model-picker-menu')?.hidden, true)
    trigger.click()
    assert.equal(
      rows()[0]?.querySelector('.model-picker-group-row-value')?.textContent,
      'Low',
      'the row shows the pick immediately, before the async save lands',
    )
  })

  it('goes back to the models without picking', async () => {
    const { trigger, rows, options, host } = await mount()
    trigger.click()
    rows()[0]?.click()
    host.querySelectorAll<HTMLButtonElement>('.model-picker-back')[1]?.click()

    assert.deepEqual(
      options().map((option) => option.dataset['value']),
      ['acp:claude', 'claude-sonnet-4-6'],
    )
  })

  it('offers the same choices on right-click, without opening the model list', async () => {
    const { trigger, picks, host } = await mount()
    trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    const menu = document.querySelector('.context-menu')
    assert.ok(menu, 'a context menu opened')
    assert.equal(host.querySelector<HTMLElement>('.model-picker-menu')?.hidden, true)
    assert.equal(menu.querySelector('.context-menu-heading')?.textContent, 'Thinking effort')
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.context-menu-item')]
    assert.deepEqual(
      items.map((item) => item.querySelector('.context-menu-item-label')?.textContent),
      ['Low', 'Medium', 'High'],
    )
    assert.equal(items[1]?.getAttribute('aria-checked'), 'true')

    items[2]?.click()
    assert.deepEqual(picks, [['thinking', 'high']])
  })
})
