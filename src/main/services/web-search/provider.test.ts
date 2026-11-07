import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { safeJsonParse } from '@shared/safe-json.ts'
import { setSetting, setApiKey, deleteApiKey } from '../storage/settings.ts'
import { clearWebOriginGrant, grantWebOriginForNextFetch } from '../security/web-origin-policy.ts'
import { webSearch } from './provider.ts'
import { installInMemorySecretCipher } from '../storage/secret-cipher.test-support.ts'

installInMemorySecretCipher()

describe('configured web search', () => {
  afterEach(async () => {
    mock.restoreAll()
    await setSetting('webSearchProvider', 'none')
    await setSetting('webAllowedOrigins', [])
    deleteApiKey('tavily')
    deleteApiKey('parallel')
    clearWebOriginGrant('https://api.tavily.com:443')
    clearWebOriginGrant('https://api.parallel.ai:443')
  })

  it('requires setup without contacting a free scraping fallback', async () => {
    await setSetting('webSearchProvider', 'none')
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json({}))
    await assert.rejects(webSearch('docs'), /Settings → Web search/)
    assert.equal(fetch.mock.callCount(), 0)
  })

  it('routes to Tavily only and consumes the approved origin grant', async () => {
    await setSetting('webSearchProvider', 'tavily')
    setApiKey('tavily', 'tavily-test-key')
    grantWebOriginForNextFetch('https://api.tavily.com:443')
    const fetch = mock.method(globalThis, 'fetch', async (url: unknown) => {
      assert.equal(url, 'https://api.tavily.com/search')
      return Response.json({
        results: [{ title: 'Docs', url: 'https://example.com/', content: 'Excerpt' }],
      })
    })
    assert.deepEqual(await webSearch('docs'), [
      { title: 'Docs', url: 'https://example.com/', snippet: 'Excerpt' },
    ])
    await assert.rejects(webSearch('docs'), /origin is not allowed/)
    assert.equal(fetch.mock.callCount(), 1)
  })

  it('routes Parallel through the same result contract', async () => {
    await setSetting('webSearchProvider', 'parallel')
    setApiKey('parallel', 'parallel-test-key')
    await setSetting('webAllowedOrigins', ['https://api.parallel.ai'])
    mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.equal(url, 'https://api.parallel.ai/v1/search')
      assert.deepEqual(typeof init?.body === 'string' ? safeJsonParse(init.body) : null, {
        objective: 'docs',
        search_queries: ['docs'],
        mode: 'basic',
      })
      return Response.json({
        results: [{ title: 'Docs', url: 'https://example.com/', excerpts: ['One', 'Two'] }],
      })
    })
    assert.deepEqual(await webSearch('docs'), [
      { title: 'Docs', url: 'https://example.com/', snippet: 'One\n\nTwo' },
    ])
  })

  it('does not try another provider when the selected provider fails', async () => {
    await setSetting('webSearchProvider', 'tavily')
    setApiKey('tavily', 'key')
    setApiKey('parallel', 'other-key')
    await setSetting('webAllowedOrigins', ['https://api.tavily.com'])
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }))
    await assert.rejects(webSearch('docs'), /rate limit/)
    assert.equal(fetch.mock.callCount(), 1)
  })
})
