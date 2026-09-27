import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchClaudePlanUsageFromCredentials, type ClaudeCredentialInput } from './claude.ts'
import { parseClaudeOAuthCredential } from './credentials.ts'
import type { FetchLike } from './types.ts'

const FIXED_NOW = 1_700_000_000_000
const now = (): number => FIXED_NOW

/** A minimal Claude usage body with one recognizable weekly window. */
const USAGE_OK = { seven_day: { utilization: 12, resets_at: '2026-08-01T00:00:00Z' } }

interface MockCall {
  url: string
  method: string
  authToken: string | undefined
  body: string | undefined
}

function trackedFetch(respond: (call: MockCall) => { status: number; body: unknown }): {
  fetch: FetchLike
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  const fetch: FetchLike = (url, init) => {
    const auth = init?.headers?.['Authorization']
    const call: MockCall = {
      url,
      method: init?.method ?? 'GET',
      authToken: typeof auth === 'string' ? auth.replace(/^Bearer /, '') : undefined,
      body: init?.body,
    }
    calls.push(call)
    const { status, body } = respond(call)
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    })
  }
  return { fetch, calls }
}

describe('parseClaudeOAuthCredential', () => {
  it('reads accessToken and expiresAt but never the refresh token', () => {
    assert.deepEqual(
      parseClaudeOAuthCredential({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-abc',
          refreshToken: 'sk-ant-ort01-xyz',
          expiresAt: 123456789,
        },
      }),
      { accessToken: 'sk-ant-oat01-abc', expiresAt: 123456789 },
    )
  })

  it('nulls expiry when absent and parses keychain string payloads', () => {
    assert.deepEqual(
      parseClaudeOAuthCredential(
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-kc' } }),
      ),
      { accessToken: 'sk-ant-oat01-kc', expiresAt: null },
    )
  })

  it('returns null for API-key-only / missing shapes', () => {
    assert.equal(parseClaudeOAuthCredential({}), null)
    assert.equal(parseClaudeOAuthCredential(null), null)
  })
})

describe('fetchClaudePlanUsageFromCredentials', () => {
  it('reports an expired token without a network call or a sign-in hint', async () => {
    const { fetch, calls } = trackedFetch(() => ({ status: 200, body: USAGE_OK }))
    const result = await fetchClaudePlanUsageFromCredentials(
      [{ accessToken: 'stale-oat', expiresAt: FIXED_NOW - 1 }],
      { fetch, now },
    )
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /access token has expired/i)
    assert.doesNotMatch(result.reason, /claude \/login|rejected/i)
    assert.equal(calls.length, 0)
  })

  it('falls through an expired credential to the next live one', async () => {
    const { fetch, calls } = trackedFetch(() => ({ status: 200, body: USAGE_OK }))
    const creds: ClaudeCredentialInput[] = [
      { accessToken: 'stale-oat', expiresAt: FIXED_NOW - 1 },
      { accessToken: 'live-oat', expiresAt: FIXED_NOW + 3_600_000 },
    ]
    const result = await fetchClaudePlanUsageFromCredentials(creds, { fetch, now })
    assert.equal(result.status, 'ok')
    assert.deepEqual(
      calls.map((c) => c.authToken),
      ['live-oat'],
    )
  })

  it('never exchanges a token when a live-looking one is rejected', async () => {
    const { fetch, calls } = trackedFetch(() => ({ status: 401, body: { error: 'revoked' } }))
    const result = await fetchClaudePlanUsageFromCredentials(
      [{ accessToken: 'revoked-oat', expiresAt: FIXED_NOW + 3_600_000 }],
      { fetch, now },
    )
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /credentials were rejected/i)
    assert.equal(calls.length, 1)
    assert.ok(calls.every((c) => !c.url.includes('/oauth/token')))
  })
})
