import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createWebSearchSection } from './web-search-section.ts'

describe('web search settings', () => {
  it('defaults to unconfigured and saves only the selected account through secret storage', async () => {
    const api = createFakeApi()
    const writes: string[] = []
    api.settings.setKey = async (provider, value): Promise<{ ok: true }> => {
      writes.push(`${provider}:${value}`)
      return { ok: true }
    }
    const section = createWebSearchSection(api)
    await section.refresh({}, new AbortController().signal)
    const select = section.root.querySelector('select')
    const tavilyKey = section.root.querySelector<HTMLInputElement>('[name="tavilyKey"]')
    const parallelKey = section.root.querySelector<HTMLInputElement>('[name="parallelKey"]')
    assert.ok(select && tavilyKey && parallelKey)
    assert.equal(select.value, 'none')
    assert.equal(tavilyKey.type, 'password')
    assert.deepEqual(section.collect(new Set()), {})
    select.value = 'tavily'
    select.dispatchEvent(new Event('change'))
    tavilyKey.value = 'tvly-test'
    parallelKey.value = 'hidden-draft'
    assert.deepEqual(section.collect(new Set(['webSearchProvider'])), {
      webSearchProvider: 'tavily',
    })
    assert.equal(await section.saveKeys(), true)
    assert.deepEqual(writes, ['tavily:tvly-test'])
    assert.equal(tavilyKey.value, '')
    section.reset()
    assert.equal(parallelKey.value, '')
  })

  it('restores a saved provider and retains a key when secure storage refuses the write', async () => {
    const api = createFakeApi()
    api.settings.setKey = async (): Promise<{
      ok: false
      reason: 'plaintext-storage-disabled'
    }> => ({
      ok: false,
      reason: 'plaintext-storage-disabled',
    })
    const section = createWebSearchSection(api)
    await section.refresh({ webSearchProvider: 'tavily' }, new AbortController().signal)
    const input = section.root.querySelector<HTMLInputElement>('[name="tavilyKey"]')
    assert.ok(input)
    input.value = 'retry-key'
    assert.equal(await section.saveKeys(), false)
    assert.equal(input.value, 'retry-key')
    assert.match(section.root.textContent, /Not saved/)
  })
})
