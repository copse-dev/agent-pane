import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveContextWindow, fetchLmStudioModelContextLength } from './resolve-context-window.ts'
import { invalidateLmStudioModelsCache } from './lm-studio-models.ts'
import { setApiKey } from '../storage/settings.test-shim.ts'

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function stubFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

describe('resolveContextWindow', () => {
  beforeEach(() => {
    invalidateLmStudioModelsCache()
  })

  it('uses cloud model table', async () => {
    assert.equal(await resolveContextWindow('gpt-4o'), 128_000)
  })

  it('uses context from /models when the server reports it', async () => {
    const restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                key: 'qwen',
                max_context_length: 262144,
                loaded_instances: [{ config: { context_length: 16384 } }],
              },
            ],
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'qwen' }] }),
      } as Response
    })
    try {
      assert.equal(await resolveContextWindow('lmstudio:qwen'), 16384)
    } finally {
      restoreFetch()
    }
  })

  it('defaults local models to 8192 when the server omits context', async () => {
    const restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/models')) {
        return { ok: true, json: async () => ({ models: [{ key: 'qwen' }] }) } as Response
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'qwen' }] }),
      } as Response
    })
    try {
      assert.equal(await resolveContextWindow('lmstudio:qwen'), 8192)
    } finally {
      restoreFetch()
    }
  })
})

describe('fetchLmStudioModelContextLength', () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
  })

  beforeEach(() => {
    invalidateLmStudioModelsCache()
    setApiKey('lmstudio', 'test-key')
  })

  it('reads max_context_length from /models when present', async () => {
    restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ key: 'qwen', max_context_length: 32768, loaded_instances: [] }],
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'qwen' }] }),
      } as Response
    })
    assert.equal(await fetchLmStudioModelContextLength('http://127.0.0.1:1234/v1', 'qwen'), 32768)
  })
})
