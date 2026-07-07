import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchOpenAiCompatibleModels } from './provider-models.ts'

const realFetch = globalThis.fetch
function stubFetch(impl: (url: string) => Partial<Response>): void {
  globalThis.fetch = (async (url: string) => impl(url)) as typeof fetch
}

describe('fetchOpenAiCompatibleModels', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('rejects a blank base URL without a network call', async () => {
    let called = false
    stubFetch(() => {
      called = true
      return { ok: true, status: 200 }
    })
    const res = await fetchOpenAiCompatibleModels('   ')
    assert.equal(res.ok, false)
    assert.equal(called, false)
  })

  it('rejects an unsafe base URL without a network call (no key sent)', async () => {
    for (const unsafe of [
      'http://attacker.example/v1', // non-loopback http:
      'https://169.254.169.254/latest', // link-local metadata endpoint
      'https://10.0.0.5/v1', // private address
      'https://user:pass@evil.example/v1', // embedded credentials
      'ftp://host/v1', // non-http(s) scheme
    ]) {
      let called = false
      stubFetch(() => {
        called = true
        return { ok: true, status: 200 }
      })
      const res = await fetchOpenAiCompatibleModels(unsafe, 'secret-key')
      assert.equal(res.ok, false, `expected ${unsafe} to be rejected`)
      assert.equal(called, false, `expected no fetch for ${unsafe}`)
      assert.ok((res.error ?? '').length > 0, `expected an error for ${unsafe}`)
    }
  })

  it('allows a loopback http: base URL (LAN-free local server)', async () => {
    let requested = ''
    stubFetch((url) => {
      requested = url
      return { ok: true, status: 200, json: async (): Promise<unknown> => ({ data: [] }) }
    })
    const res = await fetchOpenAiCompatibleModels('http://127.0.0.1:1234/v1', 'k')
    assert.equal(res.ok, true)
    assert.equal(requested, 'http://127.0.0.1:1234/v1/models')
  })

  it('does not follow redirects (Authorization is not forwarded)', async () => {
    let redirectMode: RequestRedirect | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      redirectMode = init?.redirect
      return { ok: true, status: 200, json: async (): Promise<unknown> => ({ data: [] }) }
    }) as typeof fetch
    const res = await fetchOpenAiCompatibleModels('https://api.example.com/v1', 'k')
    assert.equal(res.ok, true)
    assert.equal(redirectMode, 'manual')
  })

  it('parses ids and a context length when present, tolerating a trailing slash', async () => {
    let requested = ''
    stubFetch((url) => {
      requested = url
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({
          data: [
            { id: 'a-model' },
            { id: 'b-model', context_length: 32768 },
            { model: 'c-model' }, // some servers use `model` instead of `id`
            { notAnId: true }, // skipped
          ],
        }),
      }
    })
    const res = await fetchOpenAiCompatibleModels('https://api.example.com/v1/')
    assert.equal(requested, 'https://api.example.com/v1/models') // single slash
    assert.equal(res.ok, true)
    assert.deepEqual(res.models, [
      { id: 'a-model', contextLength: null },
      { id: 'b-model', contextLength: 32768 },
      { id: 'c-model', contextLength: null },
    ])
  })

  it('surfaces an HTTP error', async () => {
    stubFetch(() => ({ ok: false, status: 401, statusText: 'Unauthorized' }))
    const res = await fetchOpenAiCompatibleModels('https://api.example.com/v1', 'bad-key')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /401/)
  })

  it('returns an empty list when the payload has no data array', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async (): Promise<unknown> => ({}) }))
    const res = await fetchOpenAiCompatibleModels('https://api.example.com/v1')
    assert.equal(res.ok, true)
    assert.deepEqual(res.models, [])
  })

  it('catches network errors', async () => {
    globalThis.fetch = async (): Promise<never> => {
      throw new Error('boom')
    }
    const res = await fetchOpenAiCompatibleModels('https://api.example.com/v1')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /boom/)
  })
})
