import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { safeJsonParse } from '@shared/safe-json.ts'
import { requestTavilySearch } from './tavily.ts'

describe('Tavily Search client', () => {
  it('uses Basic search, caps result count and disables generated answers and automatic upgrades', async () => {
    const hits = await requestTavilySearch(
      'secret-key',
      'TypeScript docs',
      30,
      new AbortController().signal,
      async (url, init): Promise<Response> => {
        assert.equal(url, 'https://api.tavily.com/search')
        assert.ok(init)
        assert.equal(init.method, 'POST')
        assert.equal(init.redirect, 'error')
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret-key')
        assert.equal(typeof init.body, 'string')
        assert.deepEqual(typeof init.body === 'string' ? safeJsonParse(init.body) : null, {
          query: 'TypeScript docs',
          search_depth: 'basic',
          max_results: 20,
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
        })
        return Response.json({
          results: [
            {
              title: 'TypeScript',
              url: 'https://www.typescriptlang.org/',
              content: 'Official docs',
            },
          ],
          answer: 'Ignored answer',
        })
      },
    )
    assert.deepEqual(hits, [
      { title: 'TypeScript', url: 'https://www.typescriptlang.org/', snippet: 'Official docs' },
    ])
    assert.doesNotMatch(JSON.stringify(hits), /secret-key|Ignored answer/)
  })

  it('rejects authentication, credit and rate-limit errors without echoing response bodies', async () => {
    for (const [status, expected] of [
      [401, /API key/],
      [403, /API key/],
      [432, /credits/],
      [433, /credits/],
      [429, /rate limit/],
      [500, /HTTP 500/],
    ] as const) {
      await assert.rejects(
        requestTavilySearch(
          'secret',
          'docs',
          10,
          new AbortController().signal,
          async () => new Response('secret response body', { status }),
        ),
        expected,
      )
    }
  })

  it('rejects malformed JSON and malformed results', async () => {
    for (const body of [
      'invalid json',
      '{"results":"wrong"}',
      '{"results":[{"title":"missing url"}]}',
    ]) {
      await assert.rejects(
        requestTavilySearch(
          'key',
          'docs',
          10,
          new AbortController().signal,
          async () => new Response(body),
        ),
        /unexpected response shape/,
      )
    }
  })

  it('propagates cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      requestTavilySearch(
        'key',
        'docs',
        10,
        controller.signal,
        async (_url, init): Promise<Response> => {
          init?.signal?.throwIfAborted()
          return Response.json({ results: [] })
        },
      ),
      { name: 'AbortError' },
    )
  })
})
