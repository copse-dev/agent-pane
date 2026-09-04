import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidateOpenAiModelAvailability,
  isOpenAiModelAvailable,
} from './openai-model-availability.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateOpenAiModelAvailability()
})

describe('isOpenAiModelAvailable', () => {
  it('uses the account model list instead of treating a valid key as universal access', async () => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }))

    assert.equal(await isOpenAiModelAvailable('sk-test', 'gpt-6-astra'), true)
    assert.equal(await isOpenAiModelAvailable('sk-test', 'gpt-5'), false)
  })

  it('does not make a model available when the endpoint fails', async () => {
    globalThis.fetch = async (): Promise<Response> => new Response('', { status: 403 })

    assert.equal(await isOpenAiModelAvailable('sk-test', 'gpt-6-astra'), false)
  })

  it('drops the cached catalog when the credential changes', async () => {
    let calls = 0
    globalThis.fetch = async (): Promise<Response> => {
      calls += 1
      return new Response(JSON.stringify({ data: [{ id: calls === 1 ? 'gpt-6-astra' : 'gpt-5' }] }))
    }

    assert.equal(await isOpenAiModelAvailable('sk-first', 'gpt-6-astra'), true)
    invalidateOpenAiModelAvailability()
    assert.equal(await isOpenAiModelAvailable('sk-second', 'gpt-6-astra'), false)
    assert.equal(calls, 2)
  })
})
