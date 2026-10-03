import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountModelPicker, type ModelPicker } from './model-picker.ts'
import type { ModelOption } from './model-options.ts'

const options: ModelOption[] = [
  { value: 'lmstudio:qwen', label: 'Qwen', group: 'LM Studio', coverage: 'local' },
  {
    value: 'acp:claude-acp#sonnet',
    label: 'Claude Sonnet',
    group: 'Claude Code',
    coverage: 'plan',
  },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet', group: 'Anthropic API', coverage: 'paid' },
]

describe('model picker coverage controls', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  async function setup(resolved?: string): Promise<{
    host: HTMLDivElement
    picker: ModelPicker
    button: (selector: string) => HTMLButtonElement
    rows: () => string[]
    current: () => string
  }> {
    const host = document.createElement('div')
    document.body.append(host)
    let current = resolved ? 'auto:best-value' : (options[0]?.value ?? '')
    const picker = mountModelPicker(
      host,
      () => current,
      (value) => {
        current = value
      },
      async () => options,
      {
        loadOnMount: false,
        getRecentValues: () => options.map((option) => option.value),
        getCurrentRoute: () => resolved,
      },
    )
    await picker.refresh()
    function button(selector: string): HTMLButtonElement {
      const node = host.querySelector<HTMLButtonElement>(selector)
      assert.ok(node, selector)
      return node
    }
    function rows(): string[] {
      return [...host.querySelectorAll('.model-picker-option-label')].map(
        (node) => node.textContent,
      )
    }
    button('.model-picker-trigger').click()
    return { host, picker, button, rows, current: (): string => current }
  }

  it('combines coverage and search, supports empty results and keyboard selection, and resets on reopen', async () => {
    const { host, picker, button, rows, current } = await setup()
    assert.equal(host.querySelector<HTMLElement>('.model-picker-coverage-filters')?.hidden, true)
    button('.model-picker-browse').click()
    assert.equal(host.querySelector<HTMLElement>('.model-picker-coverage-filters')?.hidden, false)
    assert.equal(button('[data-coverage="all"]').getAttribute('aria-pressed'), 'true')
    button('[data-coverage="paid"]').click()
    assert.deepEqual(rows(), ['Claude Sonnet'])
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    filter.value = 'LM Studio'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    assert.deepEqual(rows(), [])
    button('[data-coverage="local"]').click()
    assert.deepEqual(rows(), ['Qwen'])
    filter.value = ''
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    button('[data-coverage="plan"]').click()
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(current(), 'acp:claude-acp#sonnet')
    assert.equal(host.querySelector<HTMLElement>('.model-picker-menu')?.hidden, true)
    button('.model-picker-trigger').click()
    button('.model-picker-browse').click()
    assert.equal(button('[data-coverage="all"]').getAttribute('aria-pressed'), 'true')
    assert.equal(rows().length, 3)
    picker.destroy()
  })

  it('shows the potential charge on the selected route and removes it for covered selections', async () => {
    const { host, picker, button } = await setup()
    const cost = host.querySelector<HTMLElement>('.model-picker-trigger .model-picker-cost')
    assert.ok(cost)
    assert.equal(cost.hidden, true)
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.model-picker-option')]
    rows.at(-1)?.click()
    assert.equal(cost.hidden, false)
    assert.equal(cost.getAttribute('aria-label'), 'Potential usage charge')
    button('.model-picker-trigger').click()
    const local = [...host.querySelectorAll<HTMLButtonElement>('.model-picker-option')].find(
      (row) => row.textContent.includes('Qwen'),
    )
    local?.click()
    assert.equal(cost.hidden, true)
    picker.destroy()
  })

  it('uses the resolved automatic route for coverage and the selected tick', async () => {
    for (const route of ['lmstudio:qwen', 'claude-sonnet-4-6']) {
      const { host, picker } = await setup(route)
      assert.equal(
        host.querySelector<HTMLElement>('.model-picker-trigger .model-picker-cost')?.hidden,
        route.startsWith('lmstudio:'),
      )
      const selected = host.querySelector('.model-picker-option[aria-selected="true"]')
      assert.ok(selected)
      assert.ok(selected.querySelector('.model-picker-option-check-slot > svg'))
      assert.ok(
        selected.textContent.includes(route.startsWith('lmstudio:') ? 'Qwen' : 'Claude Sonnet'),
      )
      picker.destroy()
    }
  })
})
