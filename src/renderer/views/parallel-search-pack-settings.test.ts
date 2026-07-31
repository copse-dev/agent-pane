import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createParallelSearchPackSettings } from './parallel-search-pack-settings.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function stubApi(saved: boolean, writes: string[]): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    settings: {
      ...base.settings,
      getKey: async (provider): Promise<boolean> => provider === 'parallel' && saved,
      getKeyEncrypted: async (): Promise<boolean | null> => (saved ? true : null),
      setKey: async (provider, key): Promise<{ ok: true }> => {
        writes.push(`${provider}:${key}`)
        return { ok: true }
      },
    },
  }
}

describe('Parallel Search pack settings', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('explains direct API and ZDR semantics and shows saved-key state', async () => {
    const root = createParallelSearchPackSettings(stubApi(true, []))
    document.body.append(root)
    await tick()

    assert.match(root.textContent, /no MCP server/i)
    assert.match(root.textContent, /Zero Data Retention is not implied/i)
    assert.equal(root.querySelector('[data-key="parallel"]')?.textContent, 'saved')
    assert.equal(root.querySelector<HTMLInputElement>('input')?.type, 'password')
  })

  it('saves the Parallel key through encrypted key storage', async () => {
    const writes: string[] = []
    const root = createParallelSearchPackSettings(stubApi(false, writes))
    document.body.append(root)
    const input = root.querySelector<HTMLInputElement>('input[name="parallelKey"]')
    const button = root.querySelector<HTMLButtonElement>('.parallel-search-save-btn')
    assert.ok(input && button)
    input.value = 'parallel-test-key'
    button.click()
    await tick()

    assert.deepEqual(writes, ['parallel:parallel-test-key'])
    assert.equal(input.value, '')
  })

  it('can clear the saved key', async () => {
    const writes: string[] = []
    const root = createParallelSearchPackSettings(stubApi(true, writes))
    document.body.append(root)
    root.querySelector<HTMLButtonElement>('.parallel-search-clear-btn')?.click()
    await tick()
    assert.deepEqual(writes, ['parallel:'])
  })
})
