import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountFooterModelPicker } from './footer-model-picker.ts'

function createApi(): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    lmStudio: { ...base.lmStudio, models: async () => [] },
    settings: {
      ...base.settings,
      availableProviders: async () => ({ anthropic: true, openai: true }),
      extraProviders: async () => [],
      get: async () => undefined,
    },
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('footer model picker', () => {
  it('opens on recent models and keeps the full searchable catalog one level deeper', async () => {
    const root = document.createElement('div')
    const composer = document.createElement('textarea')
    document.body.append(root, composer)
    let current = 'claude-sonnet-4-6'
    const selected: string[] = []
    mountFooterModelPicker(
      root,
      createApi(),
      () => current,
      (model) => {
        current = model
        selected.push(model)
      },
      {
        onClose: () => {
          composer.focus()
        },
        getRecentModels: () => [
          'claude-opus-4-8',
          'claude-sonnet-4-6',
          'gpt-5.6-sol',
          'claude-opus-4-8',
        ],
      },
    )
    assert.equal(root.querySelector('.model-picker-status')?.textContent, 'Loading models…')
    await settle()

    const trigger = root.querySelector<HTMLButtonElement>('.model-picker-trigger')
    assert.ok(trigger)
    trigger.click()

    const recentLabels = [...root.querySelectorAll<HTMLElement>('.model-picker-option')].map(
      (option) => option.textContent.split(' — ')[0],
    )
    assert.deepEqual(recentLabels, ['Claude Sonnet 4.6', 'Claude Opus 4.8', 'GPT-5.6 Sol'])
    assert.equal(root.querySelector('.model-picker-view-title')?.textContent, 'Recent')
    assert.equal(root.querySelector('.model-picker-group-label'), null)
    assert.equal(document.activeElement?.textContent.startsWith(recentLabels[0] ?? ''), true)

    const browse = root.querySelector<HTMLButtonElement>('.model-picker-browse')
    assert.ok(browse)
    browse.click()

    const filter = root.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    assert.equal(filter.hidden, false)
    assert.equal(document.activeElement, filter)
    assert.ok(root.querySelectorAll('.model-picker-option').length > recentLabels.length)
    assert.ok(root.querySelector('.model-picker-group-label'))

    filter.value = 'haiku'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    const filteredLabels = [...root.querySelectorAll<HTMLElement>('.model-picker-option')].map(
      (option) => option.textContent.split(' — ')[0],
    )
    assert.ok(filteredLabels.length > 0)
    assert.deepEqual([...new Set(filteredLabels)], ['Claude Haiku 4.5'])

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(filter.hidden, true)
    assert.equal(root.querySelector('.model-picker-view-title')?.textContent, 'Recent')

    const opus = [...root.querySelectorAll<HTMLButtonElement>('.model-picker-option')].find(
      (option) => option.textContent.startsWith('Claude Opus 4.8'),
    )
    assert.ok(opus)
    opus.click()
    assert.deepEqual(selected, ['claude-opus-4-8'])
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, composer)
  })

  it('shows the resolved route on the trigger when a dynamic selector is current', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    let current = 'auto:min-intellect:40'
    mountFooterModelPicker(
      root,
      createApi(),
      () => current,
      (model) => {
        current = model
      },
      {
        formatCurrentLabel: (sel) =>
          sel === 'auto:min-intellect:40' ? 'openrouter:minimax/minimax-m3' : sel,
      },
    )
    await settle()

    const trigger = root.querySelector<HTMLButtonElement>('.model-picker-trigger')
    assert.ok(trigger)
    // The trigger shows the resolved route (not the selector) even though the
    // stored value stays the dynamic selector.
    assert.equal(
      trigger.querySelector('.model-picker-label')?.textContent,
      'openrouter:minimax/minimax-m3',
    )
    assert.equal(current, 'auto:min-intellect:40')
  })

  it('preserves the catalog label when the override has no resolved route', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountFooterModelPicker(
      root,
      createApi(),
      () => 'claude-sonnet-4-6',
      () => {},
      {
        formatCurrentLabel: () => undefined,
      },
    )
    await settle()

    assert.equal(
      root.querySelector('.model-picker-label')?.textContent,
      'Claude Sonnet 4.6 — intellect 35.9 · $5.40/MTok',
    )
  })
})
