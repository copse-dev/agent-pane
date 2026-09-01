import { afterEach, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearProviderKeyStatusCache,
  invalidateProviderKeyStatus,
  isProviderKeyUsable,
  recordProviderKeyValidation,
} from './provider-key-status.ts'
import { setApiKey, deleteApiKey } from '../storage/settings.ts'

function stubFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

describe('provider-key-status', () => {
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    clearProviderKeyStatusCache()
    deleteApiKey('cursor')
  })

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  it('returns false when no key is configured', async () => {
    assert.equal(await isProviderKeyUsable('cursor'), false)
  })

  it('returns a recorded validation result when a key is present', async () => {
    setApiKey('cursor', 'cur_test_key')
    recordProviderKeyValidation('cursor', 'cur_test_key', true)
    assert.equal(await isProviderKeyUsable('cursor'), true)
  })

  it('drops cached validation when invalidated', async () => {
    setApiKey('cursor', 'cur_test_key')
    recordProviderKeyValidation('cursor', 'cur_test_key', true)
    invalidateProviderKeyStatus('cursor')
    deleteApiKey('cursor')
    assert.equal(await isProviderKeyUsable('cursor'), false)
  })

  it('does not apply a validation result to a different stored key', async () => {
    setApiKey('cursor', 'stored-key')
    recordProviderKeyValidation('cursor', 'unsaved-key', true)
    let calls = 0
    restoreFetch = stubFetch(async () => {
      calls += 1
      return new Response(null, { status: 403 })
    })

    assert.equal(await isProviderKeyUsable('cursor'), false)
    assert.equal(calls, 1)
  })

  it('coalesces overlapping validation requests for the same key', async () => {
    setApiKey('cursor', 'cur_test_key')
    let resolveResponse: ((response: Response) => void) | undefined
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    let calls = 0
    restoreFetch = stubFetch(async () => {
      calls += 1
      return response
    })

    const first = isProviderKeyUsable('cursor')
    const second = isProviderKeyUsable('cursor')
    assert.equal(calls, 1)
    if (!resolveResponse) assert.fail('Validation response resolver was not initialized')
    resolveResponse(new Response(null, { status: 200 }))
    assert.equal(await first, true)
    assert.equal(await second, true)
  })

  it('does not let an invalidated validation replace a newer result', async () => {
    setApiKey('cursor', 'cur_test_key')
    const resolvers: Array<(response: Response) => void> = []
    let calls = 0
    restoreFetch = stubFetch(async () => {
      calls += 1
      return new Promise<Response>((resolve) => resolvers.push(resolve))
    })

    const stale = isProviderKeyUsable('cursor')
    invalidateProviderKeyStatus('cursor')
    const fresh = isProviderKeyUsable('cursor')
    assert.equal(calls, 2)
    const resolveFresh = resolvers[1]
    if (!resolveFresh) assert.fail('Fresh validation resolver was not initialized')
    resolveFresh(new Response(null, { status: 200 }))
    assert.equal(await fresh, true)
    const resolveStale = resolvers[0]
    if (!resolveStale) assert.fail('Stale validation resolver was not initialized')
    resolveStale(new Response(null, { status: 403 }))
    assert.equal(await stale, false)

    assert.equal(await isProviderKeyUsable('cursor'), true)
    assert.equal(calls, 2)
  })
})
