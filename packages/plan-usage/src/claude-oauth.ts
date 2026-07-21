import { isRecord, readJsonBody } from './internal-utils.ts'
import type { FetchLike, PlanUsageFetchOptions } from './types.ts'

/**
 * Public Claude Code OAuth client id. This is the PKCE **public** client the
 * `claude` CLI ships with — an identifier, not a secret — so a subscription
 * refresh token can be exchanged for a fresh access token without any client
 * secret. Mirrors the CLI's own refresh so Copse never sends a stale token.
 */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

export interface ClaudeRefreshedToken {
  accessToken: string
  /** New refresh token when the server rotates it; otherwise the one we sent. */
  refreshToken: string | null
  /** Epoch ms the new access token expires; `null` when the server omits it. */
  expiresAt: number | null
}

/**
 * Exchange a Claude OAuth refresh token for a fresh access token. Throws on any
 * non-2xx / malformed response so callers can fall back to the existing
 * "re-run `claude /login`" hint rather than surfacing a half-parsed result.
 */
export async function refreshClaudeOAuthToken(
  refreshToken: string,
  options: PlanUsageFetchOptions = {},
): Promise<ClaudeRefreshedToken> {
  const token = refreshToken.trim()
  if (!token) throw new Error('Claude OAuth refresh requires a refresh token')

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const body = await readJsonBody(response, 'Claude OAuth refresh')
  if (!isRecord(body)) throw new Error('Claude OAuth refresh returned a non-object body')

  const accessToken = body['access_token']
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Claude OAuth refresh response had no access_token')
  }

  const rotated = body['refresh_token']
  const expiresIn = body['expires_in']
  return {
    accessToken: accessToken.trim(),
    // Keep the token we sent when the server does not rotate it.
    refreshToken: typeof rotated === 'string' && rotated.trim() ? rotated.trim() : token,
    expiresAt:
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : null,
  }
}
