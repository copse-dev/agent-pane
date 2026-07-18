import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  liveCacheTtlMs,
  requestLiveIntellectModels,
} from './aa-live-intellect.ts'

/** A fake fetch that records the request init and returns a canned response. */
function fakeFetch(
  response: { status?: number; statusText?: string; body?: unknown; throwErr?: Error },
): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = []
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
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
  return { fetch: fn, calls }
}

const AA_MODEL = (slug: string, idx: number, priceIn?: number) => ({
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
    assert.equal(result.models[0]?.intellect, 55.7)
    assert.equal(result.models[0]?.inputPricePerMTok, 5)
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
