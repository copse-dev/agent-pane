import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createLmStudioWarmup } from './lm-studio-warmup.ts'
import { setApiKey, setSetting } from '../storage/settings.test-shim.ts'

const model = 'qwen/chat'
const baseUrl = 'http://localhost:1234/proxy/v1/'
const origin = 'http://127.0.0.1:1234/proxy'

function catalog(loaded: string[] = [], type = 'llm'): Response {
  return Response.json({
    models: [
      {
        key: model,
        type,
        loaded_instances: loaded.map((id) => ({ id, config: { context_length: 32768 } })),
      },
    ],
  })
}

function warmer(fetch: typeof globalThis.fetch): ReturnType<typeof createLmStudioWarmup> {
  return createLmStudioWarmup({
    resolveModel: async (selection) => selection ?? `lmstudio:${model}`,
    describeProvider: async (selection) => ({
      kind: 'lm-studio',
      model: selection.slice('lmstudio:'.length),
      apiKeySlug: 'lmstudio',
      url: baseUrl,
      params: {},
    }),
    apiKey: () => 'test-key',
    fetch,
  })
}

describe('LM Studio warm-up', () => {
  it('loads a cold model using native REST, configured auth, and server load defaults', async () => {
    const requests: Array<{ url: unknown; init: RequestInit | undefined }> = []
    const warm = warmer(async (url, init) => {
      requests.push({ url, init })
      return init?.method === 'POST' ? Response.json({ status: 'loaded' }) : catalog()
    })
    await warm()
    assert.deepEqual(
      requests.map(({ url }) => url),
      [`${origin}/api/v1/models`, `${origin}/api/v1/models/load`],
    )
    for (const { init } of requests) {
      assert.ok(init)
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-key')
      assert.equal(init.redirect, 'manual')
      assert.ok(init.signal instanceof AbortSignal)
    }
    const post = requests[1]?.init
    assert.ok(post)
    assert.equal(post.body, JSON.stringify({ model }))
    assert.equal(new Headers(post.headers).get('Content-Type'), 'application/json')
  })

  it('reuses loaded models and custom instance ids without reloading their context', async () => {
    const fetch = mock.fn<typeof globalThis.fetch>(async () => catalog(['custom-instance']))
    const warm = warmer(fetch)
    await warm(`lmstudio:${model}`)
    await warm('lmstudio:custom-instance')
    assert.equal(fetch.mock.callCount(), 2)
    assert.ok(fetch.mock.calls.every(({ arguments: args }) => args[1]?.method !== 'POST'))
  })

  it('does not load a missing model or an embedding model', async () => {
    const fetch = mock.fn<typeof globalThis.fetch>(async () => catalog([], 'embedding'))
    const warm = warmer(fetch)
    await warm()
    await warm('lmstudio:missing')
    assert.equal(fetch.mock.callCount(), 2)
  })

  it('never contacts LM Studio for another provider', async () => {
    const fetch = mock.fn<typeof globalThis.fetch>(async () => catalog())
    const warm = warmer(fetch)
    for (const selection of ['claude-sonnet-4-6', 'openrouter:some/model', 'acp:codex', '']) {
      await warm(selection)
    }
    assert.equal(fetch.mock.callCount(), 0)
  })

  it('shares an in-flight load and rechecks after completion instead of caching residency', async () => {
    const loading = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<undefined>()
    let posts = 0
    const fetch = mock.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method !== 'POST') return catalog()
      posts += 1
      started.resolve(undefined)
      return posts === 1 ? loading.promise : Response.json({ status: 'loaded' })
    })
    const warm = warmer(fetch)
    const first = warm()
    await started.promise
    const second = warm()
    // Flush model/description resolution while the server still holds the load.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(fetch.mock.callCount(), 2)
    loading.resolve(Response.json({ status: 'loaded' }))
    await Promise.all([first, second])
    await warm()
    assert.equal(posts, 2)
    assert.equal(fetch.mock.callCount(), 4)
  })

  it('keeps different model loads independent', async () => {
    const seen: Array<string | null> = []
    const fetch = mock.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === 'POST') {
        seen.push(typeof init.body === 'string' ? init.body : null)
        return Response.json({ status: 'loaded' })
      }
      return Response.json({
        models: [
          { key: model, type: 'llm', loaded_instances: [] },
          { key: 'second', type: 'llm', loaded_instances: [] },
        ],
      })
    })
    const warm = warmer(fetch)
    await Promise.all([warm(), warm('lmstudio:second')])
    assert.deepEqual(
      seen.sort(),
      [JSON.stringify({ model }), JSON.stringify({ model: 'second' })].sort(),
    )
  })

  it('fails softly on unsupported, unauthorized, redirected, or malformed catalog responses', async () => {
    for (const response of [
      new Response('', { status: 404 }),
      new Response('', { status: 401 }),
      new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } }),
      new Response('invalid json'),
      Response.json({ models: [{ key: model }] }),
    ]) {
      const fetch = mock.fn<typeof globalThis.fetch>(async () => response)
      await warmer(fetch)()
      assert.equal(fetch.mock.callCount(), 1)
    }
  })

  it('releases a failed or timed-out load so a later send can retry', async () => {
    for (const error of [new Error('offline'), new DOMException('Timed out', 'TimeoutError')]) {
      let posts = 0
      const warm = warmer(async (_url, init) => {
        if (init?.method !== 'POST') return catalog()
        posts += 1
        if (posts === 1) throw error
        return Response.json({ status: 'loaded' })
      })
      await assert.doesNotReject(warm())
      await warm()
      assert.equal(posts, 2)
    }
  })

  it('does not treat a rejected load response as permanently warmed', async () => {
    let posts = 0
    const warm = warmer(async (_url, init) => {
      if (init?.method !== 'POST') return catalog()
      posts += 1
      return new Response('', { status: 500 })
    })
    await warm()
    await warm()
    assert.equal(posts, 2)
  })
})

describe('warm-up uses the inference configuration', () => {
  const originalMockMode = process.env['COPSE_PANEL_MOCK_LLM']

  afterEach(() => {
    mock.restoreAll()
    if (originalMockMode === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
    else process.env['COPSE_PANEL_MOCK_LLM'] = originalMockMode
    setSetting('model', '')
    setSetting('localDefaultModel', '')
    setSetting('localServerUrl', '')
    setSetting('roleModels', {})
    setSetting('blockedModelMakers', [])
    setApiKey('lmstudio', '')
  })

  it('resolves the saved default, legacy alias, and dynamic role with the configured URL/key', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    setSetting('model', 'lm-studio')
    setSetting('localDefaultModel', model)
    setSetting('localServerUrl', baseUrl)
    setSetting('roleModels', { coder: `lmstudio:${model}` })
    setApiKey('lmstudio', 'configured-key')
    const requests: Array<{ url: unknown; init: RequestInit | undefined }> = []
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      requests.push({ url, init })
      return init?.method === 'POST' ? Response.json({ status: 'loaded' }) : catalog()
    })
    const warm = createLmStudioWarmup()
    await warm()
    await warm('auto:role:coder')
    assert.equal(requests.length, 4)
    for (const { url, init } of requests) {
      assert.ok(typeof url === 'string' && url.startsWith(origin))
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer configured-key')
      if (init?.method === 'POST') assert.equal(init.body, JSON.stringify({ model }))
    }
  })

  it('does not contact a real server in mock mode or for a blocked maker', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => catalog())
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    await createLmStudioWarmup()(`lmstudio:${model}`)
    delete process.env['COPSE_PANEL_MOCK_LLM']
    setSetting('blockedModelMakers', ['xai'])
    await createLmStudioWarmup()('lmstudio:x-ai/grok-4.5')
    assert.equal(fetch.mock.callCount(), 0)
  })
})
