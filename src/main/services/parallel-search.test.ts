import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatParallelSearchResponse,
  PARALLEL_SEARCH_API_URL,
  requestParallelSearch,
} from './parallel-search.ts'

describe('Parallel Search client', () => {
  it('posts the documented direct Search API request without exposing the key in output', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit = {}
    const response = await requestParallelSearch(
      'parallel-secret',
      {
        objective: 'Find the current official API documentation',
        searchQueries: ['Parallel Search API docs', 'Parallel API changelog'],
        mode: 'basic',
      },
      new AbortController().signal,
      async (input, init): Promise<Response> => {
        capturedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        capturedInit = init ?? {}
        return new Response(
          JSON.stringify({
            search_id: 'search-1',
            results: [
              {
                title: 'Search API',
                url: 'https://docs.parallel.ai/search/search-api/search-quickstart',
                excerpts: ['Official documentation excerpt.'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    )

    assert.equal(capturedUrl, PARALLEL_SEARCH_API_URL)
    assert.equal(capturedInit.method, 'POST')
    assert.equal(
      capturedInit.body,
      JSON.stringify({
        objective: 'Find the current official API documentation',
        search_queries: ['Parallel Search API docs', 'Parallel API changelog'],
        mode: 'basic',
      }),
    )
    assert.equal(new Headers(capturedInit.headers).get('x-api-key'), 'parallel-secret')
    assert.equal(response.results[0]?.title, 'Search API')
    assert.doesNotMatch(formatParallelSearchResponse(response), /parallel-secret/)
  })

  it('maps authentication and credit failures to actionable errors', async () => {
    const invoke = (status: number): Promise<unknown> =>
      requestParallelSearch(
        'bad-key',
        { objective: 'Research', searchQueries: ['query'], mode: 'turbo' },
        new AbortController().signal,
        async (): Promise<Response> => new Response(null, { status }),
      )
    await assert.rejects(invoke(401), /rejected the API key/i)
    await assert.rejects(invoke(402), /insufficient credits/i)
    await assert.rejects(invoke(429), /rate limit/i)
  })

  it('formats ranked sources, warnings, and usage for citation', () => {
    const text = formatParallelSearchResponse({
      results: [
        {
          title: 'Parallel docs',
          url: 'https://docs.parallel.ai/',
          publish_date: '2026-01-01',
          excerpts: ['Dense excerpt.'],
        },
      ],
      warnings: ['query rewritten'],
      usage: [{ name: 'search', count: 1 }],
    })
    assert.match(text, /1\. Parallel docs/)
    assert.match(text, /URL: https:\/\/docs\.parallel\.ai\//)
    assert.match(text, /Published: 2026-01-01/)
    assert.match(text, /Warnings: \["query rewritten"\]/)
    assert.match(text, /Usage: search × 1/)
  })

  it('rejects malformed successful responses', async () => {
    await assert.rejects(
      requestParallelSearch(
        'key',
        { objective: 'Research', searchQueries: ['query'], mode: 'advanced' },
        new AbortController().signal,
        async (): Promise<Response> =>
          new Response(JSON.stringify({ results: 'wrong' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
      /unexpected response shape/i,
    )
  })
})
