import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createOpenAiServiceTierField } from './openai-service-tier-field.ts'

function apiWithTier(stored: unknown): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      get: async (key) => (key === 'openAiServiceTier' ? stored : null),
    },
  }
}

function picker(block: HTMLElement): HTMLSelectElement {
  const select = block.querySelector<HTMLSelectElement>('[name="openAiServiceTier"]')
  assert.ok(select)
  return select
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('OpenAI service tier field', () => {
  it('offers the supported tiers and writes nothing until one is chosen', async () => {
    const field = createOpenAiServiceTierField(apiWithTier(''))
    await field.refresh()
    const block = field.element()
    const select = picker(block)
    assert.equal(select.value, 'auto')
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ['auto', 'default', 'flex', 'fast'],
    )
    assert.match(block.textContent, /Global OpenAI service tier/)
    assert.match(block.textContent, /Applies to OpenAI API-key requests/)
    assert.deepEqual(field.readUpdate(), {})
  })

  it('maps legacy bytes to their choice but preserves them until changed', async () => {
    const field = createOpenAiServiceTierField(apiWithTier('priority'))
    await field.refresh()
    const select = picker(field.element())
    assert.equal(select.value, 'fast')
    assert.deepEqual(field.readUpdate(), {})
    choose(select, 'flex')
    assert.deepEqual(field.readUpdate(), { openAiServiceTier: 'flex' })
    // A re-render (the list repaints freely) keeps the pending choice.
    assert.equal(picker(field.element()).value, 'flex')
  })

  it('retains an advanced or unknown current tier until a supported choice is made', async () => {
    for (const current of ['scale', 'future-tier']) {
      const field = createOpenAiServiceTierField(apiWithTier(current))
      await field.refresh()
      const select = picker(field.element())
      assert.equal(select.value, current)
      assert.match(select.selectedOptions[0]?.textContent ?? '', /current/i)
      assert.deepEqual(field.readUpdate(), {})
    }
  })

  it('keeps a draft across a refresh and drops it on reset', async () => {
    const field = createOpenAiServiceTierField(apiWithTier('default'))
    await field.refresh()
    choose(picker(field.element()), 'fast')
    await field.refresh({ openAiServiceTier: 'default' })
    assert.deepEqual(field.readUpdate(), { openAiServiceTier: 'fast' })
    field.reset()
    assert.deepEqual(field.readUpdate(), {})
    assert.equal(picker(field.element()).value, 'default')
  })
})
