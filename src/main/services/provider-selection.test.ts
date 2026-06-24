import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  testLmStudio,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
  isLocalChatModel,
  buildSubagentRoute,
  buildProvider,
} from './provider-selection.ts'
import { setSetting, setApiKey } from './settings.test-shim.ts'
import { MockLLMProvider } from '@shared/llm/mock-provider.ts'

const SOURCE_PATH = resolve(process.cwd(), 'src/main/services/lm-studio-models.ts')

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

describe('lm-studio-models source integrity', () => {
  it('contains no embedded null bytes', () => {
    const src = readFileSync(SOURCE_PATH)
    assert.equal(
      src.includes(0x00),
      false,
      'lm-studio-models.ts must remain plain UTF-8 text (null bytes break tooling and cache keys)',
    )
  })

  it('builds LM Studio cache keys from url and api key only', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8')
    assert.match(src, /const cacheKey = `\$\{url\}\$\{key\}`/)
  })
})

describe('subagent local model routing', () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
    setSetting('localSubagentsEnabled', true)
    setSetting('subagentModel', '')
    setSetting('localDefaultModel', '')
    setSetting('localServerUrl', 'http://127.0.0.1:1234/v1')
  })

  it('detects local chat models', () => {
    assert.equal(isLocalChatModel('lm-studio'), true)
    assert.equal(isLocalChatModel('lmstudio:qwen2.5-3b'), true)
    assert.equal(isLocalChatModel('claude-sonnet-4-6'), false)
    assert.equal(isLocalChatModel('gpt-4o'), false)
  })

  it('returns null when the parent chat model is already local', async () => {
    const route = await buildSubagentRoute('lmstudio:local-model')
    assert.equal(route, null)
  })

  it('returns null when local subagent routing is disabled', async () => {
    setSetting('localSubagentsEnabled', false)
    const route = await buildSubagentRoute('claude-sonnet-4-6')
    assert.equal(route, null)
  })

  it('routes cloud chat models to the configured subagent local model', async () => {
    setSetting('subagentModel', 'explore-model')
    restoreFetch = stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [{ id: 'explore-model', context_length: 32_768 }],
          }),
        }) as Response,
    )

    const route = await buildSubagentRoute('claude-sonnet-4-6')
    assert.ok(route)
    assert.equal(route.contextWindow, 32_768)
    assert.equal(route.toolSchemaReserve, 2_500)
  })

  it('falls back to the default local model when subagent model is auto', async () => {
    setSetting('localDefaultModel', 'default-local')
    restoreFetch = stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ data: [{ id: 'default-local' }] }),
        }) as Response,
    )

    const route = await buildSubagentRoute('gpt-4o')
    assert.ok(route)
    assert.equal(route.contextWindow, 8192)
  })
})

describe('buildProvider', () => {
  it('uses the mock provider before LM Studio routing when mock mode is enabled', async () => {
    const prevMock = process.env.COPSE_PANEL_MOCK_LLM
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    try {
      const provider = await buildProvider('lm-studio')
      assert.ok(provider instanceof MockLLMProvider)
    } finally {
      if (prevMock === undefined) delete process.env.COPSE_PANEL_MOCK_LLM
      else process.env.COPSE_PANEL_MOCK_LLM = prevMock
    }
  })

  it('fails fast for openrouter models when no OpenRouter key is configured', async () => {
    const prevMock = process.env.COPSE_PANEL_MOCK_LLM
    const prevKey = process.env.OPENROUTER_API_KEY
    delete process.env.COPSE_PANEL_MOCK_LLM
    delete process.env.OPENROUTER_API_KEY
    try {
      await assert.rejects(
        () => buildProvider('openrouter:anthropic/claude-3.5-sonnet'),
        /OpenRouter is not configured/,
      )
    } finally {
      if (prevMock === undefined) delete process.env.COPSE_PANEL_MOCK_LLM
      else process.env.COPSE_PANEL_MOCK_LLM = prevMock
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = prevKey
    }
  })

  it('builds an OpenRouter provider from the env key', async () => {
    const prevMock = process.env.COPSE_PANEL_MOCK_LLM
    const prevKey = process.env.OPENROUTER_API_KEY
    delete process.env.COPSE_PANEL_MOCK_LLM
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    try {
      const provider = await buildProvider('openrouter:openai/gpt-4o')
      assert.ok(provider)
      assert.equal(typeof provider.stream, 'function')
    } finally {
      if (prevMock === undefined) delete process.env.COPSE_PANEL_MOCK_LLM
      else process.env.COPSE_PANEL_MOCK_LLM = prevMock
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = prevKey
    }
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
    setSetting('localServerUrl', 'http://127.0.0.1:1234/v1')
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
    assert.equal(fetchMock.mock.callCount(), 2)
  })

  it('refetches after cache invalidation', async () => {
    await listLmStudioModels()
    invalidateLmStudioModelsCache()
    await listLmStudioModels()
    assert.equal(fetchMock.mock.callCount(), 4)
  })

  it('uses a cache key without null characters', async () => {
    await listLmStudioModels()
    await listLmStudioModels()
    setApiKey('lmstudio', 'other-key')
    await listLmStudioModels()
    assert.equal(fetchMock.mock.callCount(), 4)
  })
})
