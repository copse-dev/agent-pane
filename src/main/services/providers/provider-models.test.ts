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
