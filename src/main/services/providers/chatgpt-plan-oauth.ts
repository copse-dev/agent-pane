import { createServer } from 'node:http'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
const ISSUER = 'https://auth.openai.com'
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
// Browser consent may involve MFA or workspace selection. Keep the callback
// available while the user finishes; explicit cancellation still closes it.
const SIGN_IN_TIMEOUT_MS = 15 * 60_000

export const oauthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
})
export type OAuthTokens = z.infer<typeof oauthTokenSchema>

export interface ChatGptOAuthDependencies {
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<void>
}

async function jsonRequest<T>(
  fetcher: typeof fetch,
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  // Token endpoints can echo credentials. Never propagate their body into IPC/logs.
  if (!response.ok)
    throw new Error(
      `ChatGPT authentication failed (HTTP ${String(response.status)}). Try signing in again.`,
    )
  const result = safeJsonParse(await response.text(), decodeWithSchema(schema))
  if (!result) throw new Error('ChatGPT returned an invalid authentication response.')
  return result
}

const identitySchema = z.object({
  iss: z.literal(ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  azp: z.string().optional(),
  nbf: z.number().optional(),
  exp: z.number(),
  nonce: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
})

/** RS256 is the sole algorithm advertised by OpenAI's OIDC discovery document. */
export async function verifyChatGptIdentity(
  token: string,
  clientId: string,
  nonce: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{ subject: string; label: string }> {
  const parts = token.split('.')
  const [headerPart, payloadPart, signaturePart] = parts
  if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart)
    throw new Error('Invalid ChatGPT identity token.')
  const header = safeJsonParse(
    Buffer.from(headerPart, 'base64url').toString('utf8'),
    decodeWithSchema(
      z.object({ alg: z.literal('RS256'), kid: z.string().min(1), crit: z.never().optional() }),
    ),
  )
  const identity = safeJsonParse(
    Buffer.from(payloadPart, 'base64url').toString('utf8'),
    decodeWithSchema(identitySchema),
  )
  if (!header || !identity) throw new Error('Invalid ChatGPT identity token.')
  const audience = typeof identity.aud === 'string' ? [identity.aud] : identity.aud
  if (
    !audience.includes(clientId) ||
    (audience.length > 1 && identity.azp !== clientId) ||
    (identity.azp !== undefined && identity.azp !== clientId) ||
    identity.nonce !== nonce ||
    identity.exp <= Date.now() / 1000 ||
    (identity.nbf !== undefined && identity.nbf > Date.now() / 1000)
  )
    throw new Error('ChatGPT identity validation failed.')
  const keys = await jsonRequest(
    fetcher,
    `${ISSUER}/.well-known/jwks.json`,
    z.object({
      keys: z.array(
        z.object({
          kty: z.literal('RSA'),
          kid: z.string(),
          n: z.string(),
          e: z.string(),
          use: z.literal('sig').optional(),
          alg: z.literal('RS256').optional(),
        }),
      ),
    }),
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
  )
  const key = keys.keys.find((entry) => entry.kid === header.kid)
  if (
    !key ||
    !verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    )
  )
    throw new Error('ChatGPT identity signature validation failed.')
  return { subject: identity.sub, label: identity.email ?? identity.name ?? identity.sub }
}

/** Only an exact pending state/client pair can exchange a callback code. */
export function validateChatGptCallback(
  url: URL,
  state: string,
  clientId?: string,
): { code: string; clientId: string } {
  if (
    url.pathname !== '/auth/callback' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== state
  )
    throw new Error('ChatGPT callback state validation failed.')
  if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined or failed.')
  const issued = url.searchParams.get('client_id') ?? clientId
  const code = url.searchParams.get('code')
  if (
    !issued ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(issued) ||
    issued === 'dynamic_agent_client' ||
    !code ||
    (clientId && issued !== clientId) ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.getAll('client_id').length > 1
  )
    throw new Error('ChatGPT callback registration validation failed.')
  return { code, clientId: issued }
}

export async function authorizeChatGpt(
  options: {
    hostId: string
    clientId?: string
    idTokenHint?: string
    signal: AbortSignal
    onRegistration: (clientId: string) => void
  },
  dependencies: ChatGptOAuthDependencies,
): Promise<{ clientId: string; tokens: OAuthTokens; subject: string; label: string }> {
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let accept: (value: { code: string; clientId: string }) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const callback = new Promise<{ code: string; clientId: string }>((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  // Attach the rejection handler before opening the browser or starting the listener.
  void callback.catch(() => {})
  let consumed = false
  const server = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      response.writeHead(400).end('Invalid authorization request.')
      return
    }
    if (request.method !== 'GET' || url.pathname !== '/auth/callback' || consumed) {
      response.writeHead(404).end()
      return
    }
    try {
      const result = validateChatGptCallback(url, state, options.clientId)
      consumed = true
      response
        .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        .end('ChatGPT authorization received. Return to Copse to finish connecting.')
      accept(result)
    } catch (error) {
      response
        .writeHead(400, { 'Content-Type': 'text/plain' })
        .end('Invalid or declined authorization. Return to Copse.')
      // Unsolicited callbacks cannot cancel a legitimate attempt.
      if (url.searchParams.get('state') === state)
        reject(error instanceof Error ? error : new Error('Invalid callback.'))
    }
  })
  const abort = (): void => {
    reject(new Error('ChatGPT sign-in cancelled.'))
  }
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    reject(new Error('ChatGPT sign-in timed out. Try again.'))
  }, SIGN_IN_TIMEOUT_MS)
  try {
    if (options.signal.aborted) throw new Error('ChatGPT sign-in cancelled.')
    await new Promise<void>((resolve, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Could not start the ChatGPT callback listener.')
    const redirectUri = `http://127.0.0.1:${String(address.port)}/auth/callback`
    const url = new URL(AUTHORIZE)
    url.search = new URLSearchParams({
      client_id: options.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: options.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString()
    if (!options.clientId) url.searchParams.set('agent_name_hint', 'Copse')
    if (options.idTokenHint) url.searchParams.set('id_token_hint', options.idTokenHint)
    await dependencies.openBrowser(url.toString()).catch(() => {
      // Browser-launch failures can contain the URL, including the ID-token hint.
      throw new Error('Could not open the ChatGPT sign-in browser. Try again.')
    })
    const result = await callback
    options.signal.throwIfAborted()
    options.onRegistration(result.clientId)
    const tokens = await jsonRequest(dependencies.fetch, TOKEN, oauthTokenSchema, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: result.clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
    })
    if (!tokens.id_token || !tokens.refresh_token)
      throw new Error('ChatGPT did not issue renewable credentials.')
    const identity = await verifyChatGptIdentity(
      tokens.id_token,
      result.clientId,
      nonce,
      dependencies.fetch,
      options.signal,
    )
    options.signal.throwIfAborted()
    return { clientId: result.clientId, tokens, ...identity }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    server.close()
  }
}

export function refreshChatGptTokens(
  clientId: string,
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<OAuthTokens> {
  return jsonRequest(fetcher, TOKEN, oauthTokenSchema, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: CHATGPT_RESOURCE,
    }),
  })
}

export async function revokeChatGptTokens(
  clientId: string,
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  const signal = AbortSignal.timeout(20_000)
  let endpoint: URL
  try {
    const discovery = await jsonRequest(
      fetcher,
      `${ISSUER}/.well-known/openid-configuration`,
      z.object({ issuer: z.literal(ISSUER), revocation_endpoint: z.url() }),
      { signal },
    )
    endpoint = new URL(discovery.revocation_endpoint)
    if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) return false
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }),
      })
      if (response.status === 200) return true
      if (response.status < 500) return false
    } catch {
      if (signal.aborted) return false
    }
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
  }
  return false
}
