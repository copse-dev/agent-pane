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

const CALLBACK_CLOSE_SCRIPT = `
  try { history.replaceState(null, '', '/auth/callback') } catch {}
  window.close()
`
const CALLBACK_SCRIPT_HASH = createHash('sha256').update(CALLBACK_CLOSE_SCRIPT).digest('base64')
export const CHATGPT_CALLBACK_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>ChatGPT authorization received · Copse</title>
    <style>
      :root { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #0d211c; color: #fffdf7; }
      main { width: min(100%, 520px); }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; font-size: 21px; font-weight: 650; letter-spacing: -.03em; }
      .brand svg { width: 40px; height: 40px; border-radius: 8px; flex: none; }
      .card { padding: clamp(28px, 6vw, 44px); border: 1px solid #426b5b; border-radius: 20px; background: #18372d; box-shadow: 0 24px 60px #07151066; }
      .mark { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 24px; border-radius: 50%; background: #20fd85; color: #003a35; }
      .eyebrow { margin: 0 0 10px; color: #b9d3c3; font-size: 13px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; }
      h1 { margin: 0 0 14px; font-size: clamp(28px, 5vw, 36px); font-weight: 650; line-height: 1.15; letter-spacing: -.04em; }
      p { margin: 0; color: #d9e7db; font-size: 16px; line-height: 1.6; }
      .hint { margin-top: 28px; color: #b9d3c3; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <svg viewBox="0 0 512 512" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <defs><linearGradient id="g" x1="145.7" y1="85.8" x2="406.7" y2="346.8" gradientTransform="scale(0.98604077,1.0141569)" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#003a35"/><stop offset="100%" stop-color="#001f1c"/></linearGradient></defs>
          <rect width="512" height="512" rx="72" fill="#20fd85"/>
          <g transform="translate(-12,38)"><g transform="translate(256,256) scale(1.18) translate(-256,-256)"><path d="m 380,180 c 0,-70 -90,-90 -155,-55 -65,35 -80,115 -35,170 45,55 130,45 155,-15 20,-45 -15,-85 -60,-75 -35,8 -45,50 -17,70 20,14 46,7 52,-15" fill="none" stroke="url(#g)" stroke-width="42" stroke-linecap="round"/></g></g>
        </svg>
        <span>Copse</span>
      </div>
      <section class="card" aria-labelledby="result-title">
        <div class="mark" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 24 24" fill="none"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <p class="eyebrow">ChatGPT connection</p>
        <h1 id="result-title">Authorization received</h1>
        <p>Return to Copse to finish connecting your ChatGPT account. Copse will confirm when sign-in is complete.</p>
        <p class="hint">If this tab stays open, you can close it and return to Copse.</p>
      </section>
    </main>
    <script>${CALLBACK_CLOSE_SCRIPT}</script>
  </body>
</html>`

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
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${CALLBACK_SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`,
        })
        .end(CHATGPT_CALLBACK_PAGE)
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
