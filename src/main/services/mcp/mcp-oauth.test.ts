import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { SecretCipher } from '../storage/secret-cipher.ts'
import { asProtocolTransport } from './streamable-http-transport.ts'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  COPSE_CLIENT_METADATA_URL,
  McpSignInRequiredError,
  signInMcpServer,
  signOutMcpServer,
  storedMcpOAuthProvider,
  type McpSignInDependencies,
} from './mcp-oauth.ts'
import {
  readMcpOAuthRecord,
  writeMcpOAuthRecord,
  type McpOAuthStoreDependencies,
} from './mcp-oauth-store.ts'

// A reversible stand-in for the keyring cipher: enough to prove nothing is
// stored as plaintext without depending on the OS keychain.
const scramble = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))
const testCipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
  decryptString: (buffer) => scramble(buffer).toString('utf8'),
}

function memoryStore(cipher: SecretCipher | null = testCipher): {
  store: McpOAuthStoreDependencies
  values: Map<string, unknown>
} {
  const values = new Map<string, unknown>()
  return {
    values,
    store: {
      getCipher: () => cipher,
      read: (key) => values.get(key) ?? null,
      write: async (key, value): Promise<void> => {
        values.set(key, value)
      },
      remove: async (key): Promise<void> => {
        values.delete(key)
      },
    },
  }
}

const TEST_METADATA_URL = 'https://copse.test/oauth/client-metadata.json'

/**
 * Sign-in options that keep the test off the network: the metadata document is
 * served from the fake server's state instead of copse.dev.
 */
function offline(
  server: FakeAuthServer,
): Pick<McpSignInDependencies, 'fetchFn' | 'clientMetadataUrl'> {
  const fetchFn: FetchLike = async (url, init) => {
    if (String(url) !== TEST_METADATA_URL) return fetch(url, init)
    const document = server.metadataDocument
    return document === undefined
      ? new Response('not found', { status: 404 })
      : Response.json(document)
  }
  return { fetchFn, clientMetadataUrl: TEST_METADATA_URL }
}

/** Free loopback ports for a metadata document to list. */
async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = []
  for (let index = 0; index < count; index++) {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    ports.push(address.port)
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve()
      })
    })
  }
  return ports
}

interface FakeAuthServer {
  base: string
  mcpUrl: string
  /** Every request path the server saw, in order. */
  requests: string[]
  registrations: number
  /** Access tokens the MCP endpoint currently accepts. */
  validTokens: Set<string>
  registrationStatus: number
  /** The `application_type` each registration request declared. */
  registeredApplicationTypes: unknown[]
  refreshAccepted: boolean
  /** Advertise Client ID Metadata Document support. */
  metadataDocumentSupported: boolean
  /**
   * The client's published metadata document, as the test's fetch serves it;
   * undefined serves a 404, as before a release publishes it.
   */
  metadataDocument: { client_id: string; redirect_uris: string[] } | undefined
  /** Runs before the token endpoint answers an authorization-code grant. */
  beforeCodeExchange: () => Promise<void>
  close: () => Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      resolve(body)
    })
  })
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * An authorization server and a protected MCP endpoint on one origin, the
 * shape of a typical hosted MCP server: RFC 9728 + RFC 8414 discovery, RFC
 * 7591 registration, and an authorization-code grant that enforces S256 PKCE.
 */
async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>()
  let issued = 0
  const state: FakeAuthServer = {
    base: '',
    mcpUrl: '',
    requests: [],
    registrations: 0,
    validTokens: new Set(),
    registrationStatus: 201,
    registeredApplicationTypes: [],
    refreshAccepted: true,
    metadataDocumentSupported: false,
    metadataDocument: undefined,
    beforeCodeExchange: () => Promise.resolve(),
    close: async () => undefined,
  }
  const issueTokens = (): Record<string, unknown> => {
    issued += 1
    const access = `access-${String(issued)}`
    state.validTokens.add(access)
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `refresh-${String(issued)}`,
    }
  }
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', state.base)
      state.requests.push(`${request.method ?? ''} ${url.pathname}`)
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json(response, 200, { resource: state.mcpUrl, authorization_servers: [state.base] })
        return
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, {
          issuer: state.base,
          authorization_endpoint: `${state.base}/authorize`,
          token_endpoint: `${state.base}/token`,
          registration_endpoint: `${state.base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: state.metadataDocumentSupported,
        })
        return
      }
      if (url.pathname === '/register') {
        state.registrations += 1
        if (state.registrationStatus !== 201) {
          response.writeHead(state.registrationStatus).end('Forbidden')
          return
        }
        const metadata: unknown = JSON.parse(await readBody(request))
        state.registeredApplicationTypes.push(
          typeof metadata === 'object' && metadata !== null
            ? Reflect.get(metadata, 'application_type')
            : undefined,
        )
        json(response, 201, {
          ...(typeof metadata === 'object' ? metadata : {}),
          client_id: `client-${String(state.registrations)}`,
          token_endpoint_auth_method: 'none',
        })
        return
      }
      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        // A URL client_id is a metadata document. Like Linear, this server
        // matches its redirect URIs exactly, ports included.
        const clientId = url.searchParams.get('client_id') ?? ''
        if (clientId.startsWith('https://')) {
          const document = state.metadataDocument
          if (document?.client_id !== clientId || !document.redirect_uris.includes(redirectUri)) {
            json(response, 400, { error: 'invalid_client' })
            return
          }
        }
        const code = randomUUID()
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri,
        })
        const target = new URL(redirectUri)
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') ?? '')
        response.writeHead(302, { location: target.href }).end()
        return
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(request))
        if (form.get('grant_type') === 'refresh_token') {
          if (!state.refreshAccepted) {
            json(response, 400, { error: 'invalid_grant' })
            return
          }
          json(response, 200, issueTokens())
          return
        }
        await state.beforeCodeExchange()
        const grant = codes.get(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.redirectUri !== form.get('redirect_uri')
        ) {
          json(response, 400, { error: 'invalid_grant' })
          return
        }
        codes.delete(form.get('code') ?? '')
        json(response, 200, issueTokens())
        return
      }
      if (url.pathname === '/mcp') {
        const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
        if (token === undefined || !state.validTokens.has(token)) {
          response.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"`,
          })
          response.end()
          return
        }
        const sessionId = request.headers['mcp-session-id']
        let transport = typeof sessionId === 'string' ? mcpSessions.get(sessionId) : undefined
        if (!transport) {
          const next: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string): void => {
              mcpSessions.set(id, next)
            },
          })
          const mcp = new McpServer({ name: 'oauth-fixture', version: '0.0.1' })
          mcp.registerTool('whoami', { description: 'Caller', inputSchema: {} }, () => ({
            content: [{ type: 'text', text: 'signed-in-user' }],
          }))
          await mcp.connect(asProtocolTransport(next))
          transport = next
        }
        await transport.handleRequest(request, response)
        return
      }
      response.writeHead(404).end()
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  state.base = `http://127.0.0.1:${String(address.port)}`
  state.mcpUrl = `${state.base}/mcp`
  state.close = async (): Promise<void> => {
    for (const transport of mcpSessions.values()) await transport.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  return state
}

/** The user's browser: follow the authorization redirect back to the loopback. */
async function browserThatApproves(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  assert.ok(location, 'authorization server redirected back')
  assert.match(location, /^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
  const callback = await fetch(location)
  assert.equal(callback.status, 200)
}

async function listToolsWith(
  serverUrl: string,
  store: McpOAuthStoreDependencies,
): Promise<string[]> {
  const authProvider = storedMcpOAuthProvider(serverUrl, store)
  assert.ok(authProvider, 'a stored sign-in yields a provider')
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(
    asProtocolTransport(new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider })),
  )
  try {
    const { tools } = await client.listTools()
    return tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

describe('MCP OAuth sign-in', () => {
  let server: FakeAuthServer

  beforeEach(async () => {
    server = await startFakeAuthServer()
  })

  afterEach(async () => {
    await server.close()
  })

  it('registers, authorizes with PKCE through the browser, and stores the sign-in encrypted', async () => {
    const { store, values } = memoryStore()
    const opened: string[] = []
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: async (url) => {
        opened.push(url)
        await browserThatApproves(url)
      },
    })

    assert.equal(opened.length, 1)
    const authorizeUrl = new URL(opened[0] ?? '')
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${server.base}/authorize`)
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'client-1')
    assert.ok((authorizeUrl.searchParams.get('state') ?? '').length >= 32)
    assert.equal(server.registrations, 1)

    const record = readMcpOAuthRecord(server.mcpUrl, store)
    assert.ok(record)
    assert.equal(record.tokens?.access_token, 'access-1')
    assert.equal(record.clientInformation.client_id, 'client-1')
    // Persisted as ciphertext only.
    const persisted = JSON.stringify([...values.values()])
    assert.doesNotMatch(persisted, /access-1|refresh-1/)

    assert.deepEqual(await listToolsWith(server.mcpUrl, store), ['whoami'])
  })

  it('reuses the registered client and loopback port on a later sign-in', async () => {
    const { store } = memoryStore()
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    const first = readMcpOAuthRecord(server.mcpUrl, store)
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    const second = readMcpOAuthRecord(server.mcpUrl, store)
    assert.equal(server.registrations, 1)
    assert.equal(second?.redirectUrl, first?.redirectUrl)
    assert.equal(second?.tokens?.access_token, 'access-2')
  })

  it('refreshes an expired access token without the browser', async () => {
    const { store } = memoryStore()
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    server.validTokens.clear()

    assert.deepEqual(await listToolsWith(server.mcpUrl, store), ['whoami'])
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store)?.tokens?.access_token, 'access-2')
  })

  it('reports sign-in required, without registering or redirecting, when refresh is refused', async () => {
    const { store } = memoryStore()
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    server.validTokens.clear()
    server.refreshAccepted = false
    const before = server.requests.length

    await assert.rejects(listToolsWith(server.mcpUrl, store), McpSignInRequiredError)
    const after = server.requests.slice(before)
    assert.ok(!after.includes('POST /register'), after.join(', '))
    assert.ok(!after.some((line) => line.startsWith('GET /authorize')), after.join(', '))
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store)?.tokens, undefined)
  })

  it('names registration as the step a client-allowlisting server refused', async () => {
    const { store } = memoryStore()
    server.registrationStatus = 403
    await assert.rejects(
      signInMcpServer(server.mcpUrl, {
        ...offline(server),
        store,
        openExternal: () => assert.fail('must not open the browser'),
      }),
      /refused to register Copse as a client \(HTTP 403\)\. It may only accept approved apps\./,
    )
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store), null)
  })

  it('ignores a callback with the wrong state and can be cancelled', async () => {
    const { store } = memoryStore()
    const controller = new AbortController()
    const pending = signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      signal: controller.signal,
      openExternal: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '')
        redirect.searchParams.set('code', 'stolen')
        redirect.searchParams.set('state', 'not-this-attempt')
        assert.equal((await fetch(redirect)).status, 400)
        controller.abort()
      },
    })
    await assert.rejects(pending, /Sign-in cancelled\./)
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store), null)
  })

  it('stores nothing when cancelled while the code is being exchanged', async () => {
    const { store } = memoryStore()
    const controller = new AbortController()
    server.beforeCodeExchange = async (): Promise<void> => {
      controller.abort()
      // Answer slowly enough that the abort reaches the in-flight request.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await assert.rejects(
      signInMcpServer(server.mcpUrl, {
        ...offline(server),
        store,
        signal: controller.signal,
        openExternal: browserThatApproves,
      }),
      /^Error: Sign-in cancelled\.$/,
    )
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store), null)
  })

  it('reports a sign-in the user declines in the browser', async () => {
    const { store } = memoryStore()
    await assert.rejects(
      signInMcpServer(server.mcpUrl, {
        ...offline(server),
        store,
        openExternal: async (url) => {
          const authorize = new URL(url)
          const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '')
          redirect.searchParams.set('error', 'access_denied')
          redirect.searchParams.set('error_description', 'The user denied access')
          redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '')
          // Declined before the first auth() leg has even returned.
          assert.equal((await fetch(redirect)).status, 200)
        },
      }),
      /The server declined the sign-in: The user denied access/,
    )
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store), null)
  })

  it('refuses to sign in when tokens could only be stored as plaintext', async () => {
    const { store } = memoryStore(null)
    await assert.rejects(
      signInMcpServer(server.mcpUrl, {
        ...offline(server),
        store,
        openExternal: () => assert.fail('must not open the browser'),
      }),
      /secure storage is unavailable/,
    )
    assert.equal(server.requests.length, 0)
  })

  it('binds a stored sign-in to its URL and forgets it on sign-out', async () => {
    const { store, values } = memoryStore()
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    const record = readMcpOAuthRecord(server.mcpUrl, store)
    assert.ok(record)

    // The same record presented under another URL's key authorizes nothing.
    const elsewhere = 'https://attacker.example/mcp'
    await writeMcpOAuthRecord({ ...record, serverUrl: elsewhere }, store)
    const [ownKey, otherKey] = [...values.keys()]
    assert.ok(ownKey && otherKey)
    values.set(otherKey, values.get(ownKey))
    assert.equal(readMcpOAuthRecord(elsewhere, store), null)
    assert.equal(storedMcpOAuthProvider(elsewhere, store), undefined)

    await signOutMcpServer(server.mcpUrl, store)
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store), null)
  })
  it('identifies Copse by its metadata document where the server supports one', async () => {
    const { store } = memoryStore()
    const ports = await freePorts(2)
    server.metadataDocumentSupported = true
    server.metadataDocument = {
      client_id: TEST_METADATA_URL,
      redirect_uris: ports.map((port) => `http://127.0.0.1:${String(port)}/callback`),
    }
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })

    assert.equal(server.registrations, 0)
    const record = readMcpOAuthRecord(server.mcpUrl, store)
    assert.ok(record)
    assert.equal(record.clientInformation.client_id, TEST_METADATA_URL)
    // Listening on a port the document lists is what lets a server that
    // matches redirect URIs exactly accept the sign-in.
    assert.ok(ports.includes(Number(new URL(record.redirectUrl).port)))
    assert.equal(record.authorizationServer, server.base)

    server.validTokens.clear()
    assert.deepEqual(await listToolsWith(server.mcpUrl, store), ['whoami'])
  })

  it('registers as a native app when the metadata document cannot be used', async () => {
    const ports = await freePorts(1)
    const listed = {
      client_id: TEST_METADATA_URL,
      redirect_uris: ports.map((port) => `http://127.0.0.1:${String(port)}/callback`),
    }
    const signIn = async (): Promise<void> => {
      await signInMcpServer(server.mcpUrl, {
        ...offline(server),
        store: memoryStore().store,
        openExternal: browserThatApproves,
      })
    }

    // Not yet published (a 404), as before a release deploys it.
    server.metadataDocumentSupported = true
    server.metadataDocument = undefined
    await signIn()
    // Published, but the server does not support metadata documents.
    server.metadataDocumentSupported = false
    server.metadataDocument = listed
    await signIn()
    // Supported and published, but every port it lists is taken.
    server.metadataDocumentSupported = true
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(ports[0], '127.0.0.1', resolve))
    try {
      await signIn()
    } finally {
      await new Promise<void>((resolve) => {
        occupied.close(() => {
          resolve()
        })
      })
    }

    assert.equal(server.registrations, 3)
    assert.deepEqual(server.registeredApplicationTypes, ['native', 'native', 'native'])
  })

  it('does not present a registration to a different authorization server', async () => {
    const { store } = memoryStore()
    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    const record = readMcpOAuthRecord(server.mcpUrl, store)
    assert.ok(record)
    await writeMcpOAuthRecord(
      { ...record, authorizationServer: 'https://elsewhere.example' },
      store,
    )

    server.validTokens.clear()
    await assert.rejects(listToolsWith(server.mcpUrl, store), McpSignInRequiredError)

    await signInMcpServer(server.mcpUrl, {
      ...offline(server),
      store,
      openExternal: browserThatApproves,
    })
    assert.equal(server.registrations, 2)
    assert.equal(readMcpOAuthRecord(server.mcpUrl, store)?.authorizationServer, server.base)
  })

  it('publishes a metadata document that names itself and lists loopback callbacks', () => {
    const document = safeJsonParse(
      readFileSync(resolvePath('site/oauth/client-metadata.json'), 'utf8'),
      decodeWithSchema(
        z.looseObject({
          client_id: z.string(),
          client_name: z.string(),
          redirect_uris: z.array(z.string()).min(1),
          token_endpoint_auth_method: z.string(),
        }),
      ),
    )
    assert.ok(document)
    assert.equal(document.client_id, COPSE_CLIENT_METADATA_URL)
    assert.equal(document.client_name, 'Copse')
    assert.equal(document.token_endpoint_auth_method, 'none')
    for (const uri of document.redirect_uris) {
      assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    }
  })
})
