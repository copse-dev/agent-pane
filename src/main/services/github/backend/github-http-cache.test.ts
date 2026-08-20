import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  githubCachedGet,
  githubRateLimitRemaining,
  isGitCommitSha,
  isGitHubRateLimited,
  resetGitHubHttpCacheForTest,
  setGitHubHttpCacheClockForTest,
} from './github-http-cache.ts'

const calls: Array<{ url: string; ifNoneMatch: string | null }> = []
const originalFetch = globalThis.fetch
let now = 1_000_000

interface RouteResult {
  status?: number
  body?: unknown
  etag?: string
  remaining?: string
  retryAfter?: string
}

let router: (url: string, ifNoneMatch: string | null) => RouteResult = (): RouteResult => ({
  body: {},
})

function installFetch(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    const ifNoneMatch = headers.get('If-None-Match')
    calls.push({ url, ifNoneMatch })
    const routed = router(url, ifNoneMatch)
    const responseHeaders = new Headers()
    if (routed.etag) responseHeaders.set('ETag', routed.etag)
    responseHeaders.set('X-RateLimit-Remaining', routed.remaining ?? '4999')
    responseHeaders.set('X-RateLimit-Reset', String(Math.floor(now / 1000) + 3600))
    responseHeaders.set('X-RateLimit-Resource', 'core')
    if (routed.retryAfter) responseHeaders.set('Retry-After', routed.retryAfter)
    const status = routed.status ?? 200
    const body = status === 304 ? null : JSON.stringify(routed.body ?? {})
    return Promise.resolve(new Response(body, { status, headers: responseHeaders }))
  }
}

afterEach((): void => {
  globalThis.fetch = originalFetch
  resetGitHubHttpCacheForTest()
  setGitHubHttpCacheClockForTest(null)
  calls.length = 0
  router = (): RouteResult => ({ body: {} })
  now = 1_000_000
})

describe('githubCachedGet', () => {
  it('revalidates with If-None-Match and does not replace the body on 304', async () => {
    setGitHubHttpCacheClockForTest((): number => now)
    installFetch()
    router = (_url, ifNoneMatch): RouteResult =>
      ifNoneMatch
        ? { status: 304, etag: '"v1"' }
        : { body: { n: 1 }, etag: '"v1"', remaining: '4998' }

    const first = await githubCachedGet('https://api.github.com/repos/o/r', {
      Authorization: 'Bearer t',
    })
    assert.equal(first.fromCache, false)
    assert.deepEqual(first.json, { n: 1 })
    assert.equal(githubRateLimitRemaining(), 4998)

    const second = await githubCachedGet('https://api.github.com/repos/o/r', {
      Authorization: 'Bearer t',
    })
    assert.equal(second.fromCache, true)
    assert.deepEqual(second.json, { n: 1 })
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.ifNoneMatch, '"v1"')
  })

  it('serves an immutable blob without a second network call', async () => {
    setGitHubHttpCacheClockForTest((): number => now)
    installFetch()
    router = (): RouteResult => ({ body: { content: 'abc' }, etag: '"blob"' })
    const url =
      'https://api.github.com/repos/o/r/contents/f.ts?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await githubCachedGet(url, { Authorization: 'Bearer t' }, { immutable: true })
    const second = await githubCachedGet(url, { Authorization: 'Bearer t' }, { immutable: true })
    assert.equal(second.fromCache, true)
    assert.equal(calls.length, 1)
  })

  it('coalesces concurrent GETs for the same URL into one fetch', async () => {
    setGitHubHttpCacheClockForTest((): number => now)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetch()
    const innerFetch = globalThis.fetch
    globalThis.fetch = async (input, init): Promise<Response> => {
      await gate
      return innerFetch(input, init)
    }
    router = (): RouteResult => ({ body: { ok: true }, etag: '"x"' })

    const a = githubCachedGet('https://api.github.com/user', { Authorization: 'Bearer t' })
    const b = githubCachedGet('https://api.github.com/user', { Authorization: 'Bearer t' })
    release?.()
    const [first, second] = await Promise.all([a, b])
    assert.equal(calls.length, 1)
    assert.deepEqual(first.json, second.json)
  })

  it('serves stale cache when GitHub reports remaining=0', async () => {
    setGitHubHttpCacheClockForTest((): number => now)
    installFetch()
    router = (): RouteResult => ({ body: { n: 1 }, etag: '"v1"', remaining: '0' })
    await githubCachedGet('https://api.github.com/user', { Authorization: 'Bearer t' })
    assert.equal(isGitHubRateLimited(), true)
    const second = await githubCachedGet('https://api.github.com/user', {
      Authorization: 'Bearer t',
    })
    assert.equal(second.fromCache, true)
    assert.equal(calls.length, 1)
  })
})

describe('isGitCommitSha', () => {
  it('accepts a 40-char hex SHA and rejects branch names', () => {
    assert.equal(isGitCommitSha('0123456789abcdef0123456789abcdef01234567'), true)
    assert.equal(isGitCommitSha('main'), false)
    assert.equal(isGitCommitSha('0123456789abcdef'), false)
  })
})
