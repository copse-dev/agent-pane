import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchClaudePlanUsageFromCredentials, type ClaudeCredentialInput } from './claude.ts'
import { refreshClaudeOAuthToken } from './claude-oauth.ts'
import { parseClaudeOAuthCredential } from './credentials.ts'
import type { FetchLike } from './types.ts'
import { isRecord } from './internal-utils.ts'

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

const isTokenUrl = (url: string): boolean => url.includes('/oauth/token')

describe('parseClaudeOAuthCredential', () => {
  it('reads accessToken, refreshToken, and expiresAt', () => {
    assert.deepEqual(
      parseClaudeOAuthCredential({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-abc',
          refreshToken: 'sk-ant-ort01-xyz',
          expiresAt: 123456789,
        },
      }),
      { accessToken: 'sk-ant-oat01-abc', refreshToken: 'sk-ant-ort01-xyz', expiresAt: 123456789 },
    )
  })

  it('nulls refresh/expiry when absent and parses keychain string payloads', () => {
    assert.deepEqual(
      parseClaudeOAuthCredential(
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-kc' } }),
      ),
      { accessToken: 'sk-ant-oat01-kc', refreshToken: null, expiresAt: null },
    )
  })

  it('returns null for API-key-only / missing shapes', () => {
    assert.equal(parseClaudeOAuthCredential({}), null)
    assert.equal(parseClaudeOAuthCredential(null), null)
  })
})

describe('refreshClaudeOAuthToken', () => {
  it('exchanges the refresh token and computes expiresAt from expires_in', async () => {
    const { fetch, calls } = trackedFetch(() => ({
      status: 200,
      body: { access_token: 'fresh-oat', refresh_token: 'rotated-ort', expires_in: 3600 },
    }))
    const result = await refreshClaudeOAuthToken('old-ort', { fetch, now })
    assert.deepEqual(result, {
      accessToken: 'fresh-oat',
      refreshToken: 'rotated-ort',
      expiresAt: FIXED_NOW + 3600 * 1000,
    })
    const posted: unknown = JSON.parse(calls[0]?.body ?? '{}')
    assert.ok(isRecord(posted))
    assert.equal(posted['grant_type'], 'refresh_token')
    assert.equal(posted['refresh_token'], 'old-ort')
    assert.equal(calls[0]?.method, 'POST')
  })

  it('keeps the sent refresh token when the server does not rotate it', async () => {
    const { fetch } = trackedFetch(() => ({
      status: 200,
      body: { access_token: 'fresh-oat', expires_in: 60 },
    }))
    const result = await refreshClaudeOAuthToken('keep-me', { fetch, now })
    assert.equal(result.refreshToken, 'keep-me')
  })

  it('throws on a non-2xx response', async () => {
    const { fetch } = trackedFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    await assert.rejects(() => refreshClaudeOAuthToken('dead', { fetch, now }))
  })
})

describe('fetchClaudePlanUsageFromCredentials', () => {
  it('proactively refreshes an expired access token before fetching', async () => {
    const { fetch, calls } = trackedFetch((call) => {
      if (isTokenUrl(call.url)) {
        return { status: 200, body: { access_token: 'fresh-oat', expires_in: 3600 } }
      }
      return call.authToken === 'fresh-oat'
        ? { status: 200, body: USAGE_OK }
        : { status: 401, body: { error: 'expired' } }
    })
    const refreshed: Array<{ source: string | undefined; token: string }> = []
    const cred: ClaudeCredentialInput = {
      accessToken: 'stale-oat',
      refreshToken: 'good-ort',
      expiresAt: FIXED_NOW - 10_000, // already expired
      source: 'keychain',
    }
    const result = await fetchClaudePlanUsageFromCredentials([cred], {
      fetch,
      now,
      onTokenRefreshed: (c, r) => {
        refreshed.push({ source: c.source, token: r.accessToken })
      },
    })
    assert.equal(result.status, 'ok')
    // One token exchange, then exactly one usage call (with the fresh token).
    assert.equal(calls.filter((c) => isTokenUrl(c.url)).length, 1)
    const usageCalls = calls.filter((c) => !isTokenUrl(c.url))
    assert.equal(usageCalls.length, 1)
    assert.equal(usageCalls[0]?.authToken, 'fresh-oat')
    assert.deepEqual(refreshed, [{ source: 'keychain', token: 'fresh-oat' }])
  })

  it('reactively refreshes and retries once when a live-looking token is rejected', async () => {
    const { fetch, calls } = trackedFetch((call) => {
      if (isTokenUrl(call.url)) {
        return { status: 200, body: { access_token: 'fresh-oat', expires_in: 3600 } }
      }
      return call.authToken === 'fresh-oat'
        ? { status: 200, body: USAGE_OK }
        : { status: 401, body: { error: 'revoked' } }
    })
    const result = await fetchClaudePlanUsageFromCredentials(
      [
        {
          accessToken: 'stale-oat',
          refreshToken: 'good-ort',
          expiresAt: FIXED_NOW + 3_600_000, // looks valid, but server rejects
          source: 'credentials.json',
        },
      ],
      { fetch, now },
    )
    assert.equal(result.status, 'ok')
    // First usage (401) → refresh → second usage (200).
    assert.equal(calls.filter((c) => !isTokenUrl(c.url)).length, 2)
    assert.equal(calls.filter((c) => isTokenUrl(c.url)).length, 1)
  })

  it('falls back to the rejected hint when the refresh itself fails', async () => {
    const { fetch } = trackedFetch((call) => {
      if (isTokenUrl(call.url)) return { status: 400, body: { error: 'invalid_grant' } }
      return { status: 401, body: { error: 'expired' } }
    })
    const result = await fetchClaudePlanUsageFromCredentials(
      [{ accessToken: 'stale', refreshToken: 'dead-ort', expiresAt: FIXED_NOW - 1, source: 'env' }],
      { fetch, now },
    )
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /credentials were rejected/i)
  })

  it('does not attempt a refresh when there is no refresh token', async () => {
    const { fetch, calls } = trackedFetch(() => ({ status: 401, body: { error: 'expired' } }))
    const result = await fetchClaudePlanUsageFromCredentials([{ accessToken: 'no-refresh' }], {
      fetch,
      now,
    })
    assert.equal(result.status, 'unavailable')
    assert.equal(calls.filter((c) => isTokenUrl(c.url)).length, 0)
  })
})
