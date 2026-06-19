import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { testLmStudio, listLmStudioModels, invalidateLmStudioModelsCache } from './agent-service.ts'
import { setSetting, setApiKey } from './settings.test-shim.ts'

const SOURCE_PATH = resolve(process.cwd(), 'src/main/services/agent-service.ts')

function stubFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

function authHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined
  return (headers as Record<string, string>).Authorization
}

describe('agent-service source integrity', () => {
  it('contains no embedded null bytes', () => {
    const src = readFileSync(SOURCE_PATH)
    assert.equal(
      src.includes(0x00),
      false,
      'agent-service.ts must remain plain UTF-8 text (null bytes break tooling and cache keys)',
    )
  })

  it('builds LM Studio cache keys from url and api key only', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8')
    assert.match(src, /const cacheKey = `\$\{url\}\$\{lmStudioKey\(\)\}`/)
  })
})

describe('testLmStudio', () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  it('returns model ids from a successful /models response', async () => {
    const fetchMock = mock.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ id: 'qwen2.5-3b' }, { id: 'llama-3' }] }),
    }))
    restoreFetch = stubFetch(fetchMock as unknown as typeof fetch)

    const result = await testLmStudio('http://127.0.0.1:1234/v1/', 'test-key')
    assert.deepEqual(result, { ok: true, models: ['qwen2.5-3b', 'llama-3'] })

    const call = fetchMock.mock.calls[0]!
    assert.equal(call.arguments[0], 'http://127.0.0.1:1234/v1/models')
    assert.equal(authHeader(call.arguments[1] as RequestInit), 'Bearer test-key')
  })

  it('surfaces HTTP errors without throwing', async () => {
    restoreFetch = stubFetch(
      async () =>
        ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        }) as Response,
    )

    const result = await testLmStudio('http://127.0.0.1:1234/v1')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /503/)
  })
})

describe('listLmStudioModels cache', () => {
  let fetchMock: ReturnType<typeof mock.fn>
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    invalidateLmStudioModelsCache()
    setSetting('lmStudioUrl', 'http://127.0.0.1:1234/v1')
    setApiKey('lmstudio', 'cache-test-key')
    fetchMock = mock.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ id: 'local-model' }] }),
    }))
    restoreFetch = stubFetch(fetchMock as unknown as typeof fetch)
  })

  afterEach(() => {
    invalidateLmStudioModelsCache()
    restoreFetch?.()
    restoreFetch = undefined
  })

  it('reuses cached models within TTL', async () => {
    const first = await listLmStudioModels()
    const second = await listLmStudioModels()
    assert.deepEqual(first, ['local-model'])
    assert.deepEqual(second, ['local-model'])
    assert.equal(fetchMock.mock.callCount(), 1)
  })

  it('refetches after cache invalidation', async () => {
    await listLmStudioModels()
    invalidateLmStudioModelsCache()
    await listLmStudioModels()
    assert.equal(fetchMock.mock.callCount(), 2)
  })

  it('uses a cache key without null characters', async () => {
    await listLmStudioModels()
    await listLmStudioModels()
    // Changing the stored key should miss cache and trigger another fetch.
    setApiKey('lmstudio', 'other-key')
    await listLmStudioModels()
    assert.equal(fetchMock.mock.callCount(), 2)
  })
})
