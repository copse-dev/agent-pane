import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveModelCard,
  resetModelCardResolverCache,
  PROBE_OK_TTL_MS,
  PROBE_FAIL_TTL_MS,
} from './model-card-resolver.ts'

const realFetch = globalThis.fetch

/** Record every probe so "did we refetch?" is directly assertable. */
function stubFetch(handler: (url: string, method: string) => number | 'throw'): {
  calls: Array<{ url: string; method: string }>
} {
  const calls: Array<{ url: string; method: string }> = []
  const fake = (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const outcome = handler(url, method)
    if (outcome === 'throw') return Promise.reject(new Error('network down'))
    return Promise.resolve(new Response(null, { status: outcome }))
  }
  Object.defineProperty(globalThis, 'fetch', { value: fake, configurable: true, writable: true })
  return { calls }
}

describe('resolveModelCard', () => {
  beforeEach(() => {
    resetModelCardResolverCache()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: realFetch,
      configurable: true,
      writable: true,
    })
    resetModelCardResolverCache()
    mock.reset()
  })

  it('returns the first candidate that resolves', async () => {
    stubFetch(() => 200)
    const card = await resolveModelCard('claude-opus-4-8')
    assert.ok(card)
    assert.equal(card.origin, 'curated')
    assert.equal(card.verified, true)
  })

  it('does not probe weaker candidates once a better one resolves', async () => {
    const { calls } = stubFetch(() => 200)
    await resolveModelCard('openrouter:zai-org/GLM-5.2')
    // The canonical repo path answered, so the other providers' spellings are
    // never requested — ordering is what keeps a guess off the wire.
    assert.equal(calls.length, 1)
    const [only] = calls
    assert.ok(only)
    assert.match(only.url, /zai-org\/GLM-5\.2$/)
  })

  it('falls through to the next candidate when one 404s', async () => {
    const { calls } = stubFetch((url) => (url.includes('zai-org') ? 404 : 200))
    const card = await resolveModelCard('openrouter:zai-org/GLM-5.2')
    assert.ok(card, 'expected a fallback candidate to resolve')
    assert.equal(card.origin, 'hf-derived')
    assert.ok(calls.length >= 2)
  })

  it('returns null, not a broken link, when nothing resolves', async () => {
    stubFetch(() => 404)
    assert.equal(await resolveModelCard('openrouter:zai-org/GLM-5.2'), null)
  })

  it('returns null for a model with no candidates without touching the network', async () => {
    const { calls } = stubFetch(() => 200)
    assert.equal(await resolveModelCard('lmstudio:some-local-gguf'), null)
    assert.equal(calls.length, 0)
  })

  it('caches a success — a second resolve costs no network', async () => {
    const { calls } = stubFetch(() => 200)
    await resolveModelCard('claude-opus-4-8')
    const before = calls.length
    await resolveModelCard('claude-opus-4-8')
    assert.equal(calls.length, before, 'a cached URL must not be refetched')
  })

  it('caches a failure, so a model with no card stops re-probing', async () => {
    // Without negative caching this is the "refetching forever" case: every
    // hover would re-probe every candidate for a model that has no card.
    const { calls } = stubFetch(() => 404)
    await resolveModelCard('openrouter:zai-org/GLM-5.2')
    const before = calls.length
    assert.ok(before > 0)
    await resolveModelCard('openrouter:zai-org/GLM-5.2')
    await resolveModelCard('openrouter:zai-org/GLM-5.2')
    assert.equal(calls.length, before, 'a cached failure must not be refetched')
  })

  it('shares the cache across models that point at one URL', async () => {
    const { calls } = stubFetch(() => 200)
    await resolveModelCard('claude-opus-4-8')
    const before = calls.length
    // Every Claude id resolves to the same Anthropic hub.
    await resolveModelCard('claude-sonnet-5')
    assert.equal(calls.length, before, 'the shared hub must be probed once, not per model')
  })

  it('collapses concurrent resolves of the same URL into one probe', async () => {
    const { calls } = stubFetch(() => 200)
    await Promise.all([resolveModelCard('claude-opus-4-8'), resolveModelCard('claude-sonnet-5')])
    assert.equal(calls.length, 1)
  })

  it('retries with GET when a host rejects HEAD', async () => {
    // Several vendor CDNs answer HEAD with 403/405 but serve the page fine; a
    // false negative there would hide a real card.
    const { calls } = stubFetch((_url, method) => (method === 'HEAD' ? 405 : 200))
    const card = await resolveModelCard('claude-opus-4-8')
    assert.ok(card)
    assert.deepEqual(
      calls.map((c) => c.method),
      ['HEAD', 'GET'],
    )
  })

  it('treats a network error as a failure rather than throwing', async () => {
    stubFetch(() => 'throw')
    assert.equal(await resolveModelCard('claude-opus-4-8'), null)
  })

  it('keeps a failure cached for less time than a success', () => {
    // A newly published card should be picked up in a day; a link that already
    // resolved need not be re-checked nearly as often.
    assert.ok(PROBE_FAIL_TTL_MS < PROBE_OK_TTL_MS)
  })
})
