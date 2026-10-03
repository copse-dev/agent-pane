// OAuth for remote (Streamable HTTP) MCP servers, per the MCP authorization
// spec: RFC 9728 protected-resource discovery, RFC 8414 authorization-server
// metadata, client identification, and the authorization-code grant with PKCE.
// The SDK's `auth()` runs those steps; this module supplies the two
// `OAuthClientProvider`s it drives and the loopback redirect (RFC 8252).
//
// Client identification follows the spec's order of preference. Where the
// authorization server supports Client ID Metadata Documents, Copse identifies
// itself by the URL of its published document (`site/oauth/client-metadata.json`)
// instead of registering a new client per install; otherwise it falls back to
// RFC 7591 dynamic registration. The document lists fixed loopback ports because
// some servers match redirect URIs exactly rather than allowing any loopback
// port, so sign-in listens on one of those ports when it uses the document.
//
// Two providers, two very different powers:
//  - `storedMcpOAuthProvider` is attached at connect time. It presents stored
//    tokens and lets the SDK refresh them, but it can never start a browser
//    flow: when a fresh authorization is needed it throws, and the server is
//    reported as needing sign-in. Startup therefore never opens a browser or
//    registers a client.
//  - `signInMcpServer` runs only from an explicit Settings action. It registers
//    a client if needed, opens the authorization URL in the user's browser, and
//    waits for the code on a one-shot 127.0.0.1 listener bound to this attempt's
//    `state`.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  canStoreMcpOAuth,
  deleteMcpOAuthRecord,
  mcpOAuthServerIdentity,
  readMcpOAuthRecord,
  writeMcpOAuthRecord,
  type McpOAuthRecord,
  type McpOAuthStoreDependencies,
} from './mcp-oauth-store.ts'

const LOOPBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const CLIENT_METADATA_TIMEOUT_MS = 5_000

/** Copse's OAuth Client ID Metadata Document, published from `site/oauth/client-metadata.json`. */
export const COPSE_CLIENT_METADATA_URL = 'https://copse.dev/oauth/client-metadata.json'

const clientMetadataDocumentSchema = z.looseObject({
  client_id: z.string(),
  redirect_uris: z.array(z.string()),
})

/** A stored sign-in can no longer be refreshed; the user has to sign in again. */
export class McpSignInRequiredError extends Error {
  constructor() {
    super('Sign-in required')
    this.name = 'McpSignInRequiredError'
  }
}

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  // The MCP spec requires native clients to say so when they register; the
  // SDK's type has no `application_type`, but it sends this object as-is.
  const metadata = {
    client_name: 'Copse',
    application_type: 'native',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }
  return metadata
}

function toRecordTokens(tokens: OAuthTokens): McpOAuthRecord['tokens'] {
  return { ...tokens }
}

function toRecordClient(
  information: OAuthClientInformationMixed,
): McpOAuthRecord['clientInformation'] {
  return { ...information }
}

/**
 * The provider a connect attaches when this URL has a stored sign-in, or
 * undefined when it has none (the connect then runs unauthenticated, and a 401
 * reports the server as needing sign-in).
 */
export function storedMcpOAuthProvider(
  serverUrl: string,
  store?: McpOAuthStoreDependencies,
): OAuthClientProvider | undefined {
  const initial = readMcpOAuthRecord(serverUrl, store)
  if (!initial?.tokens) return undefined
  let record: McpOAuthRecord = initial
  // Once the server rejects the client itself, only an interactive sign-in may
  // register a new one; a background connect must not.
  let clientRevoked = false
  const persist = async (next: McpOAuthRecord): Promise<void> => {
    record = next
    await writeMcpOAuthRecord(next, store)
  }
  return {
    // Must stay defined: the SDK treats a missing redirect URL as a
    // client-credentials client and would try that grant instead.
    get redirectUrl(): string {
      return record.redirectUrl
    },
    get clientMetadata(): OAuthClientMetadata {
      return clientMetadata(record.redirectUrl)
    },
    clientInformation: (): McpOAuthRecord['clientInformation'] => {
      if (clientRevoked) throw new McpSignInRequiredError()
      return record.clientInformation
    },
    saveClientInformation: (information) =>
      persist({ ...record, clientInformation: toRecordClient(information) }),
    tokens: () => record.tokens,
    saveTokens: (tokens) => persist({ ...record, tokens: toRecordTokens(tokens) }),
    // A registration belongs to the authorization server that issued it. If the
    // resource now points somewhere else, sign in again rather than present it.
    saveDiscoveryState: (discovered): void => {
      if (discovered.authorizationServerUrl !== record.authorizationServer) {
        throw new McpSignInRequiredError()
      }
    },
    redirectToAuthorization: (): never => {
      throw new McpSignInRequiredError()
    },
    saveCodeVerifier: () => undefined,
    codeVerifier: (): never => {
      throw new McpSignInRequiredError()
    },
    invalidateCredentials: async (scope): Promise<void> => {
      if (scope === 'all' || scope === 'client') {
        clientRevoked = true
        await deleteMcpOAuthRecord(serverUrl, store)
        return
      }
      if (scope === 'tokens') {
        await persist({
          serverUrl: record.serverUrl,
          redirectUrl: record.redirectUrl,
          authorizationServer: record.authorizationServer,
          clientInformation: record.clientInformation,
        })
      }
    },
  }
}

interface LoopbackCallback {
  redirectUrl: string
  /** Resolves with the authorization code once the browser returns. */
  code: Promise<string>
  close: () => void
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Loopback listener has no port.'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_HOST)
  })
}

function callbackPage(title: string, body: string): string {
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:16px system-ui;margin:3em auto;max-width:32em"><h1 style="font-size:1.25em">${escape(title)}</h1><p>${escape(body)}</p></body>`
}

/**
 * A one-shot listener on 127.0.0.1. It tries `preferredPorts` in order — the
 * port the client was last registered with, then the metadata document's — as
 * authorization servers commonly match redirect URIs exactly, and falls back to
 * any free port, which then needs a new registration.
 */
async function openLoopbackCallback(
  state: string,
  preferredPorts: readonly number[],
): Promise<LoopbackCallback> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A refusal can arrive while the first `auth()` leg is still running, before
  // anything awaits `code`; without a handler that rejection would be unhandled.
  code.catch(() => undefined)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end()
      return
    }
    // Only the browser that started this attempt carries its state; anything
    // else is ignored rather than allowed to end the sign-in.
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(callbackPage('Sign-in link expired', 'Start the sign-in again from Copse.'))
      return
    }
    const error = url.searchParams.get('error')
    const authorizationCode = url.searchParams.get('code')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (error !== null || !authorizationCode) {
      response.end(callbackPage('Sign-in was not completed', 'You can close this tab.'))
      const reason = (url.searchParams.get('error_description') ?? error ?? 'no code returned')
        .replace(/\s+/g, ' ')
        .slice(0, 200)
      settle?.reject(new Error(`The server declined the sign-in: ${reason}`))
      return
    }
    response.end(callbackPage('Signed in', 'You can close this tab and return to Copse.'))
    settle?.resolve(authorizationCode)
  })
  let port: number | undefined
  for (const candidate of preferredPorts) {
    port = await listen(server, candidate).catch(() => undefined)
    if (port !== undefined) break
  }
  port ??= await listen(server, 0)
  return {
    redirectUrl: `http://${LOOPBACK_HOST}:${String(port)}${CALLBACK_PATH}`,
    code,
    close: (): void => {
      server.close()
      server.closeAllConnections()
    },
  }
}

function registeredPort(record: McpOAuthRecord | null): number | undefined {
  if (!record) return undefined
  const url = new URL(record.redirectUrl)
  return url.hostname === LOOPBACK_HOST && url.port ? Number(url.port) : undefined
}

/**
 * The loopback callback ports Copse's published metadata document allows, or
 * none when it cannot be used: unreachable (for example before a release has
 * published it), malformed, or not naming itself as its `client_id`.
 */
async function clientMetadataDocumentPorts(
  documentUrl: string,
  fetchFn: FetchLike,
): Promise<number[]> {
  try {
    const response = await fetchFn(documentUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const document = safeJsonParse(
      await response.text(),
      decodeWithSchema(clientMetadataDocumentSchema),
    )
    if (document?.client_id !== documentUrl) return []
    return document.redirect_uris.flatMap((uri) => {
      const url = URL.parse(uri)
      return url?.protocol === 'http:' &&
        url.hostname === LOOPBACK_HOST &&
        url.pathname === CALLBACK_PATH &&
        url.port !== ''
        ? [Number(url.port)]
        : []
    })
  } catch {
    return []
  }
}

function waitForCode(callback: LoopbackCallback, signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const finish = (outcome: { ok: true; code: string } | { ok: false; error: Error }): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (outcome.ok) resolve(outcome.code)
      else reject(outcome.error)
    }
    const onAbort = (): void => {
      finish({ ok: false, error: new Error('Sign-in cancelled.') })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error('Sign-in timed out. Start it again from Copse.') })
    }, SIGN_IN_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    callback.code.then(
      (code) => {
        finish({ ok: true, code })
      },
      (error: unknown) => {
        finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
      },
    )
  })
}

export interface McpSignInDependencies {
  /** Hand the authorization URL to the user's browser. */
  openExternal: (url: string) => Promise<void>
  fetchFn?: FetchLike
  store?: McpOAuthStoreDependencies
  signal?: AbortSignal
  /** Where Copse's Client ID Metadata Document is published. */
  clientMetadataUrl?: string
}

/**
 * Sign in to one remote MCP server and store the result. Resolves once the
 * tokens are stored; the caller reconnects the server.
 */
export async function signInMcpServer(
  serverUrl: string,
  dependencies: McpSignInDependencies,
): Promise<void> {
  const { store } = dependencies
  if (!canStoreMcpOAuth(store)) {
    throw new Error('Copse cannot store MCP sign-ins because secure storage is unavailable.')
  }
  const identity = mcpOAuthServerIdentity(serverUrl)
  const existing = readMcpOAuthRecord(identity, store)
  const { signal } = dependencies
  const baseFetch: FetchLike = dependencies.fetchFn ?? fetch
  const metadataUrl = dependencies.clientMetadataUrl ?? COPSE_CLIENT_METADATA_URL
  const metadataPorts = await clientMetadataDocumentPorts(metadataUrl, baseFetch)
  const existingPort = registeredPort(existing)
  const state = randomBytes(32).toString('base64url')
  const callback = await openLoopbackCallback(state, [
    ...(existingPort === undefined ? [] : [existingPort]),
    ...metadataPorts,
  ])
  try {
    // The stored client is reused only for the same redirect URI at the same
    // authorization server; otherwise the SDK identifies Copse afresh.
    const reusable = existing?.redirectUrl === callback.redirectUrl ? existing : undefined
    const metadataUsable = metadataPorts.includes(Number(new URL(callback.redirectUrl).port))
    let authorizationServer: string | undefined
    let clientInformation: OAuthClientInformationMixed | undefined
    let codeVerifier: string | undefined
    let tokens: OAuthTokens | undefined
    // Which network step a failure belongs to, so the message can say so.
    let phase: SignInPhase = 'discovery'
    const provider: OAuthClientProvider = {
      redirectUrl: callback.redirectUrl,
      clientMetadata: clientMetadata(callback.redirectUrl),
      ...(metadataUsable ? { clientMetadataUrl: metadataUrl } : {}),
      state: () => state,
      saveDiscoveryState: (discovered): void => {
        authorizationServer = discovered.authorizationServerUrl
      },
      clientInformation: () => {
        if (
          clientInformation === undefined &&
          reusable !== undefined &&
          reusable.authorizationServer === authorizationServer
        ) {
          clientInformation = reusable.clientInformation
        }
        phase = clientInformation === undefined ? 'registration' : 'authorization'
        return clientInformation
      },
      saveClientInformation: (information) => {
        clientInformation = information
        phase = 'authorization'
      },
      // A sign-in always asks the user afresh rather than refreshing silently.
      tokens: () => undefined,
      saveTokens: (next) => {
        tokens = next
      },
      redirectToAuthorization: async (authorizationUrl) => {
        if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
          throw new Error('The server returned an authorization URL Copse will not open.')
        }
        await dependencies.openExternal(authorizationUrl.href)
      },
      saveCodeVerifier: (verifier) => {
        codeVerifier = verifier
      },
      codeVerifier: () => {
        if (codeVerifier === undefined) throw new Error('Sign-in has no PKCE verifier.')
        return codeVerifier
      },
    }
    // Cancelling aborts whichever request is in flight, including the token
    // exchange after the browser has already returned.
    const fetchFn: FetchLike = (url, init) =>
      baseFetch(url, signal === undefined ? init : { ...init, signal })
    const throwIfCancelled = (): void => {
      if (signal?.aborted) throw new Error('Sign-in cancelled.')
    }
    const run = async (authorizationCode?: string): Promise<string> => {
      try {
        return await auth(provider, {
          serverUrl: identity,
          fetchFn,
          ...(authorizationCode === undefined ? {} : { authorizationCode }),
        })
      } catch (error) {
        throwIfCancelled()
        throw new Error(describeAuthFailure(error, phase), { cause: error })
      }
    }
    const started = await run()
    if (started !== 'AUTHORIZED') {
      const authorizationCode = await waitForCode(callback, signal)
      phase = 'token'
      await run(authorizationCode)
    }
    // A cancel that lands after the last response must still store nothing.
    throwIfCancelled()
    if (!clientInformation || !tokens || authorizationServer === undefined) {
      throw new Error('The server did not issue a sign-in.')
    }
    await writeMcpOAuthRecord(
      {
        serverUrl: identity,
        redirectUrl: callback.redirectUrl,
        authorizationServer,
        clientInformation: toRecordClient(clientInformation),
        tokens: toRecordTokens(tokens),
      },
      store,
    )
  } finally {
    callback.close()
  }
}

/** Forget a server's stored sign-in. */
export function signOutMcpServer(
  serverUrl: string,
  store?: McpOAuthStoreDependencies,
): Promise<void> {
  return deleteMcpOAuthRecord(serverUrl, store)
}

type SignInPhase = 'discovery' | 'registration' | 'authorization' | 'token'

/** `HTTP 403: Invalid OAuth error response: … Raw body: Forbidden` → `HTTP 403`. */
function shortAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = /^HTTP (\d{3})\b/.exec(message)
  if (status) return `HTTP ${status[1] ?? ''}`
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

/**
 * Registration is where a server that only admits approved clients refuses,
 * and the SDK's error for that is a bare HTTP status; name the step instead.
 */
function describeAuthFailure(error: unknown, phase: SignInPhase): string {
  const detail = shortAuthError(error)
  if (/does not support dynamic client registration/i.test(detail)) {
    return 'This server does not let new apps register, so Copse cannot sign in to it.'
  }
  switch (phase) {
    case 'discovery':
      return `This server does not advertise an OAuth sign-in Copse can use (${detail}).`
    case 'registration':
      return `This server refused to register Copse as a client (${detail}). It may only accept approved apps.`
    case 'authorization':
      return `Copse could not start the sign-in (${detail}).`
    case 'token':
      return `The server did not accept the sign-in (${detail}).`
  }
}
