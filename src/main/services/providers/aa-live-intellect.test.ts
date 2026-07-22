import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchLiveIntellectModels,
  liveCacheTtlMs,
  requestLiveIntellectModels,
} from './aa-live-intellect.ts'

/** A fake fetch that records the request init and returns a canned response. */
function fakeFetch(response: {
  status?: number
  statusText?: string
  body?: unknown
  throwErr?: Error
}): { fetch: typeof fetch; calls: RequestInit[]; urls: string[] } {
  const calls: RequestInit[] = []
  const urls: string[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
    calls.push(init ?? {})
    if (response.throwErr) throw response.throwErr
    const status = response.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: response.statusText ?? '',
      json: async () => response.body ?? {},
    } as Response
  }) as typeof fetch
  return { fetch: fn, calls, urls }
}

const AA_MODEL = (slug: string, idx: number, priceIn?: number): Record<string, unknown> => ({
  slug,
  evaluations: { artificial_analysis_intelligence_index: idx },
  ...(priceIn !== undefined
    ? { pricing: { price_1m_input_tokens: priceIn, price_1m_output_tokens: priceIn * 2 } }
    : {}),
})

describe('requestLiveIntellectModels', () => {
  it('follows redirects (matching the working sync path), never manual', async () => {
    const { fetch, calls } = fakeFetch({ body: { data: [] } })
    await requestLiveIntellectModels('key', fetch)
    assert.equal(calls[0]?.redirect, 'follow')
  })

  it('uses the current free-shape language endpoint that carries task cost', async () => {
    const { fetch, urls } = fakeFetch({ body: { data: [] } })
    await requestLiveIntellectModels('key', fetch)
    assert.match(urls[0] ?? '', /\/api\/v2\/language\/models\/free\?page=1$/)
  })

  it('sends the key as the x-api-key header', async () => {
    const { fetch, calls } = fakeFetch({ body: { data: [] } })
    await requestLiveIntellectModels('secret-key', fetch)
    assert.deepEqual((calls[0]?.headers as Record<string, string>)['x-api-key'], 'secret-key')
  })

  it('reduces a 200 payload to scored, priced models and reads the index version', async () => {
    const { fetch } = fakeFetch({
      body: {
        artificial_analysis_intelligence_index_version: '4.1',
        data: [
          AA_MODEL('claude-opus-4-8', 55.7, 5),
          // No intelligence score → dropped.
          { slug: 'unscored', pricing: { price_1m_input_tokens: 1 } },
        ],
      },
    })
    const result = await requestLiveIntellectModels('key', fetch)
    assert.equal(result.ok, true)
    assert.equal(result.indexVersion, '4.1')
    assert.equal(result.models.length, 1)
    assert.equal(result.models[0]?.id, 'claude-opus-4-8')
    assert.equal(result.models[0].intellect, 55.7)
    assert.equal(result.models[0].inputPricePerMTok, 5)
  })

  it('loads every page of a paginated response', async () => {
    const pages: Record<number, unknown> = {
      1: {
        intelligence_index_version: 4.1,
        pagination: { page: 1, total_pages: 2, has_more: true },
        data: [AA_MODEL('page-one', 20, 1)],
      },
      2: {
        intelligence_index_version: 4.1,
        pagination: { page: 2, total_pages: 2, has_more: false },
        data: [AA_MODEL('page-two', 30, 2)],
      },
    }
    const urls: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      const page = Number(new URL(url).searchParams.get('page'))
      return { ok: true, status: 200, statusText: '', json: async () => pages[page] } as Response
    }) as typeof globalThis.fetch
    const result = await requestLiveIntellectModels('key', fetch)
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['page-one', 'page-two'],
    )
    assert.equal(result.indexVersion, 4.1)
    assert.equal(urls.length, 2)
  })

  it('extracts costPerTask from artificial_analysis_intelligence_index_cost (documented AA shape)', async () => {
    // Shape from AA Data API docs / free-tier models payload — not the mock env path.
    // pricing holds token prices only; cost-per-task lives on the model-level cost object.
    const { fetch } = fakeFetch({
      body: {
        artificial_analysis_intelligence_index_version: '4.1',
        data: [
          {
            slug: 'gpt-5',
            evaluations: { artificial_analysis_intelligence_index: 72.4 },
            pricing: {
              price_1m_input_tokens: 1.25,
              price_1m_output_tokens: 10,
            },
            artificial_analysis_intelligence_index_cost: {
              total_cost: 1.84,
              cost_per_task: { total_cost: 1.84 },
            },
          },
        ],
      },
    })
    const result = await requestLiveIntellectModels('key', fetch)
    assert.equal(result.ok, true)
    assert.equal(result.models.length, 1)
    const model = result.models[0]
    assert.ok(model)
    assert.equal(model.id, 'gpt-5')
    assert.equal(model.costPerTask, 1.84)
    assert.equal(model.inputPricePerMTok, 1.25)
  })

  it('surfaces a rejected key (403) with an actionable message', async () => {
    const { fetch } = fakeFetch({ status: 403, statusText: 'Forbidden' })
    const result = await requestLiveIntellectModels('bad-key', fetch)
    assert.equal(result.ok, false)
    assert.equal(result.models.length, 0)
    assert.match(result.error ?? '', /HTTP 403/)
    assert.match(result.error ?? '', /key was rejected/)
  })

  it('reports a non-auth HTTP error without the key hint', async () => {
    const { fetch } = fakeFetch({ status: 500, statusText: 'Server Error' })
    const result = await requestLiveIntellectModels('key', fetch)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /HTTP 500/)
    assert.doesNotMatch(result.error ?? '', /key was rejected/)
  })

  it('turns a thrown network/timeout error into a failed result, not a throw', async () => {
    const { fetch } = fakeFetch({ throwErr: new Error('network down') })
    const result = await requestLiveIntellectModels('key', fetch)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /network down/)
  })
})

describe('liveCacheTtlMs', () => {
  it('caches a real cohort for hours but a failure only briefly', () => {
    const cohort = liveCacheTtlMs({ ok: true, models: [{ id: 'x', intellect: 50 }] })
    const failure = liveCacheTtlMs({ ok: false, models: [], error: 'HTTP 403' })
    const empty = liveCacheTtlMs({ ok: true, models: [] })
    assert.ok(cohort > failure, 'a cohort should out-cache a failure')
    // An empty/unparseable success is treated like a failure so it doesn't stick.
    assert.equal(empty, failure)
    assert.ok(failure <= 60_000)
  })
})

describe('fetchLiveIntellectModels mock', () => {
  it('returns the e2e cohort when COPSE_AA_INTELLECT_MOCK=1', async () => {
    const prev = process.env['COPSE_AA_INTELLECT_MOCK']
    process.env['COPSE_AA_INTELLECT_MOCK'] = '1'
    try {
      const result = await fetchLiveIntellectModels()
      assert.equal(result.ok, true)
      assert.equal(result.indexVersion, '4.1')
      assert.ok(result.models.length >= 4)
      assert.ok(result.models.every((m) => typeof m.costPerTask === 'number' && m.costPerTask > 0))
    } finally {
      if (prev === undefined) delete process.env['COPSE_AA_INTELLECT_MOCK']
      else process.env['COPSE_AA_INTELLECT_MOCK'] = prev
    }
  })
})
