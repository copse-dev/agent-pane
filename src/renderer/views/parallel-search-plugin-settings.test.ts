import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { createParallelSearchPluginSettings } from './parallel-search-plugin-settings.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function stubApi(saved: boolean, writes: string[]): ApiClient {
  const base = createFakeApi()
  // Mutable so a save/clear through the view flips what `getKey` reports next,
  // the way the host store does — the key-presence callback reads it again.
  let hasKey = saved
  return {
    ...base,
    settings: {
      ...base.settings,
      getKey: async (provider): Promise<boolean> => provider === 'parallel' && hasKey,
      getKeyEncrypted: async (): Promise<boolean | null> => (hasKey ? true : null),
      setKey: async (provider, key): Promise<{ ok: true }> => {
        writes.push(`${provider}:${key}`)
        if (provider === 'parallel') hasKey = key !== ''
        return { ok: true }
      },
    },
  }
}

describe('Parallel Search plugin settings', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('explains direct API and ZDR semantics and shows saved-key state', async () => {
    const root = createParallelSearchPluginSettings(stubApi(true, []))
    document.body.append(root)
    await tick()

    assert.match(root.textContent, /no MCP server/i)
    assert.match(root.textContent, /Zero Data Retention is not implied/i)
    assert.equal(root.querySelector('[data-key="parallel"]')?.textContent, 'saved')
    assert.equal(root.querySelector<HTMLInputElement>('input')?.type, 'password')
  })

  it('saves the Parallel key through encrypted key storage', async () => {
    const writes: string[] = []
    const root = createParallelSearchPluginSettings(stubApi(false, writes))
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
    const root = createParallelSearchPluginSettings(stubApi(true, writes))
    document.body.append(root)
    root.querySelector<HTMLButtonElement>('.parallel-search-clear-btn')?.click()
    await tick()
    assert.deepEqual(writes, ['parallel:'])
  })

  it('reports key presence on load so the plugin toggle can gate on it', async () => {
    const seen: boolean[] = []
    document.body.append(
      createParallelSearchPluginSettings(stubApi(false, []), {
        onKeyPresence: (hasKey) => seen.push(hasKey),
      }),
    )
    await tick()
    assert.deepEqual(seen, [false])
  })

  it('re-reports presence after a save and after a clear', async () => {
    const seen: boolean[] = []
    const root = createParallelSearchPluginSettings(stubApi(false, []), {
      onKeyPresence: (hasKey) => seen.push(hasKey),
    })
    document.body.append(root)
    await tick()

    const input = root.querySelector<HTMLInputElement>('input[name="parallelKey"]')
    assert.ok(input)
    input.value = 'parallel-test-key'
    root.querySelector<HTMLButtonElement>('.parallel-search-save-btn')?.click()
    await tick()
    assert.deepEqual(seen, [false, true])

    root.querySelector<HTMLButtonElement>('.parallel-search-clear-btn')?.click()
    await tick()
    assert.deepEqual(seen, [false, true, false])
  })
})
