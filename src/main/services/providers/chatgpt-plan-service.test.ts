import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { ChatGptPlanService } from './chatgpt-plan-service.ts'
import {
  verifyChatGptIdentity,
  validateChatGptCallback,
  type ChatGptOAuthDependencies,
} from './chatgpt-plan-oauth.ts'
import {
  chatGptPlanStatus,
  type ChatGptPlanState,
  type ChatGptPlanStore,
} from './chatgpt-plan-store.ts'
import { runWithExplicitSettings } from '../storage/settings-context.ts'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  use: 'sig',
  alg: 'RS256',
}

function jwt(
  nonce: string,
  clientId = 'oaiapp_copse',
  subject = 'user-1',
  expires = Date.now() / 1000 + 3600,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: clientId,
      sub: subject,
      exp: expires,
      nonce,
      email: 'user@example.com',
    }),
  ).toString('base64url')
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    keys.privateKey,
  ).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function memoryStore(initial?: ChatGptPlanState): ChatGptPlanStore {
  let state = initial ?? {
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    activeClientId: null,
    accounts: [],
  }
  return {
    read: (): ChatGptPlanState => structuredClone(state),
    write: (next): void => {
      state = structuredClone(next)
    },
  }
}

function savedState(): ChatGptPlanState {
  return {
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    activeClientId: 'oaiapp_copse',
    accounts: [
      {
        clientId: 'oaiapp_copse',
        subject: 'user-1',
        label: 'user@example.com',
        credentials: {
          accessToken: 'access-before',
          refreshToken: 'refresh-before',
          idToken: 'retained-id',
          scopes: ['chatgpt.tokens.use.direct'],
          expiresAt: 0,
        },
      },
    ],
  }
}

function authFixture(
  options: { scope?: string; subject?: string; invalidStateFirst?: boolean } = {},
): {
  dependencies: ChatGptOAuthDependencies
  authorizations: URL[]
  tokenRequests: URLSearchParams[]
} {
  const authorizations: URL[] = []
  const tokenRequests: URLSearchParams[] = []
  return {
    authorizations,
    tokenRequests,
    dependencies: {
      openBrowser: async (raw): Promise<void> => {
        const authorization = new URL(raw)
        authorizations.push(authorization)
        const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '')
        const malformedStatus = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(
            { hostname: callback.hostname, port: callback.port, path: 'http://[' },
            (response) => {
              response.resume()
              resolve(response.statusCode ?? 0)
            },
          )
          request.on('error', reject)
          request.end()
        })
        assert.equal(malformedStatus, 400)
        callback.search = new URLSearchParams({
          state: authorization.searchParams.get('state') ?? '',
          code: 'one-time-code',
          client_id: 'oaiapp_copse',
        }).toString()
        if (options.invalidStateFirst) {
          const bad = new URL(callback)
          bad.searchParams.set('state', 'unsolicited')
          assert.equal((await fetch(bad)).status, 400)
        }
        assert.equal((await fetch(callback)).status, 200)
      },
      fetch: async (input, init): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/jwks.json')) return Response.json({ keys: [publicKey] })
        if (url.endsWith('/oauth/token')) {
          assert.ok(init?.body instanceof URLSearchParams)
          tokenRequests.push(init.body)
          const authorization = authorizations.at(-1)
          assert.ok(authorization)
          assert.equal(init.body.get('client_id'), 'oaiapp_copse')
          assert.equal(
            init.body.get('redirect_uri'),
            authorization.searchParams.get('redirect_uri'),
          )
          assert.equal(init.body.get('resource'), 'https://api.openai.com/v1')
          assert.equal(init.body.has('client_secret'), false)
          const verifier = init.body.get('code_verifier')
          assert.ok(verifier)
          const { createHash } = await import('node:crypto')
          assert.equal(
            createHash('sha256').update(verifier).digest('base64url'),
            authorization.searchParams.get('code_challenge'),
          )
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            id_token: jwt(
              authorization.searchParams.get('nonce') ?? '',
              'oaiapp_copse',
              options.subject,
            ),
            expires_in: 3600,
            token_type: 'Bearer',
            scope: options.scope ?? 'openid offline_access chatgpt.tokens.use.direct',
          })
        }
        throw new Error(`Unexpected test request ${url}`)
      },
    },
  }
}

describe('ChatGPT plan OAuth and account lifecycle', () => {
  it('keeps the callback available when browser consent takes longer than three minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = authFixture()
    const service = new ChatGptPlanService(memoryStore(), {
      ...fixture.dependencies,
      openBrowser: async (url): Promise<void> => {
        t.mock.timers.tick(4 * 60_000)
        await fixture.dependencies.openBrowser(url)
      },
    })
    const result = await service.signIn()
    assert.equal(result.accounts.at(0)?.connected, true)
  })

  it('still cancels a delayed browser attempt and closes its callback listener', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const opened = Promise.withResolvers<string>()
    const fixture = authFixture()
    const service = new ChatGptPlanService(memoryStore(), {
      ...fixture.dependencies,
      openBrowser: async (url): Promise<void> => {
        opened.resolve(url)
      },
    })
    const signingIn = service.signIn()
    const authorization = new URL(await opened.promise)
    t.mock.timers.tick(4 * 60_000)
    service.cancelSignIn()
    await assert.rejects(signingIn, /sign-in cancelled/)
    const callback = authorization.searchParams.get('redirect_uri')
    assert.ok(callback)
    await assert.rejects(fetch(callback), /fetch failed/)
  })

  it('registers via real loopback, verifies identity, keeps tokens out of public status, and reuses the registration/host', async () => {
    const store = memoryStore()
    const fixture = authFixture({ invalidStateFirst: true })
    const service = new ChatGptPlanService(store, fixture.dependencies)
    const first = await service.signIn()
    assert.equal(first.activeClientId, 'oaiapp_copse')
    assert.equal(first.accounts.at(0)?.planEnabled, true)
    assert.equal(first.accounts.at(0)?.label, 'user@example.com')
    assert.equal(JSON.stringify(first).includes('new-access'), false)
    const initial = fixture.authorizations.at(0)
    assert.ok(initial)
    assert.equal(initial.searchParams.get('client_id'), 'dynamic_agent_client')
    assert.equal(initial.searchParams.get('agent_name_hint'), 'Copse')
    await service.signIn('oaiapp_copse')
    const returning = fixture.authorizations.at(1)
    assert.ok(returning)
    assert.equal(returning.searchParams.get('client_id'), 'oaiapp_copse')
    assert.equal(returning.searchParams.has('agent_name_hint'), false)
    assert.equal(
      returning.searchParams.get('ext_agent_host_id'),
      initial.searchParams.get('ext_agent_host_id'),
    )
    assert.notEqual(returning.searchParams.get('state'), initial.searchParams.get('state'))
    assert.equal(store.read().accounts.length, 1)
  })

  it('retains identity-only sign-in but prevents inference when direct permission is absent', async () => {
    const service = new ChatGptPlanService(
      memoryStore(),
      authFixture({ scope: 'openid email' }).dependencies,
    )
    const result = await service.signIn()
    assert.equal(result.accounts.at(0)?.connected, true)
    assert.equal(result.accounts.at(0)?.planEnabled, false)
    await assert.rejects(service.credentials('oaiapp_copse'), /permission was not granted/)
    assert.deepEqual(await service.models(), { clientId: 'oaiapp_copse', models: [] })
  })

  it('cannot replace a returning account with another verified identity', async () => {
    const store = memoryStore(savedState())
    const service = new ChatGptPlanService(
      store,
      authFixture({ subject: 'another-user' }).dependencies,
    )
    await assert.rejects(service.signIn('oaiapp_copse'), /different account/)
    assert.equal(store.read().accounts.at(0)?.credentials?.refreshToken, 'refresh-before')
  })

  it('rejects wrong state, declined consent, duplicate parameters, and client substitution', () => {
    const url = new URL(
      'http://127.0.0.1/auth/callback?state=expected&code=code&client_id=oaiapp_copse',
    )
    assert.deepEqual(validateChatGptCallback(url, 'expected'), {
      code: 'code',
      clientId: 'oaiapp_copse',
    })
    assert.throws(() => validateChatGptCallback(url, 'wrong'), /state/)
    assert.throws(() => validateChatGptCallback(url, 'expected', 'other'), /registration/)
    url.searchParams.append('code', 'duplicate')
    assert.throws(() => validateChatGptCallback(url, 'expected'), /registration/)
    url.searchParams.set('error', 'access_denied')
    assert.throws(() => validateChatGptCallback(url, 'expected'), /declined/)
  })

  it('rejects invalid signature, audience, nonce and expired identity tokens', async () => {
    const fetcher: typeof fetch = async () => Response.json({ keys: [publicKey] })
    await assert.rejects(
      verifyChatGptIdentity(jwt('nonce'), 'other-client', 'nonce', fetcher),
      /validation/,
    )
    await assert.rejects(
      verifyChatGptIdentity(jwt('nonce'), 'oaiapp_copse', 'other-nonce', fetcher),
      /validation/,
    )
    await assert.rejects(
      verifyChatGptIdentity(
        jwt('nonce', 'oaiapp_copse', 'user-1', 0),
        'oaiapp_copse',
        'nonce',
        fetcher,
      ),
      /validation/,
    )
    const valid = jwt('nonce')
    const [signedHeader, signedPayload] = valid.split('.')
    assert.ok(signedHeader && signedPayload)
    await assert.rejects(
      verifyChatGptIdentity(
        `${signedHeader}.${signedPayload}.invalid`,
        'oaiapp_copse',
        'nonce',
        fetcher,
      ),
      /signature/,
    )
  })

  it('serializes concurrent refreshes and atomically persists the rotated refresh token', async () => {
    const store = memoryStore(savedState())
    let refreshes = 0
    const service = new ChatGptPlanService(store, {
      openBrowser: async (): Promise<void> => {},
      fetch: async (_input, init): Promise<Response> => {
        refreshes++
        assert.ok(init?.body instanceof URLSearchParams)
        assert.equal(init.body.get('refresh_token'), 'refresh-before')
        assert.equal(init.body.has('scope'), false)
        return Response.json({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      },
    })
    const results = await Promise.all([
      service.credentials('oaiapp_copse'),
      service.credentials('oaiapp_copse'),
    ])
    assert.equal(refreshes, 1)
    assert.equal(results.at(1)?.accessToken, 'rotated-access')
    assert.equal(store.read().accounts.at(0)?.credentials?.refreshToken, 'rotated-refresh')
    const restarted = new ChatGptPlanService(store, {
      openBrowser: async (): Promise<void> => {},
      fetch: async (): Promise<Response> => {
        throw new Error('Must reuse saved credentials')
      },
    })
    assert.equal((await restarted.credentials('oaiapp_copse')).accessToken, 'rotated-access')
  })

  it('lists the OAuth catalog in server order, filters hidden models, and keeps accounts separate', async () => {
    const state = savedState()
    const first = state.accounts.at(0)
    assert.ok(first?.credentials)
    first.credentials.expiresAt = Date.now() + 3600_000
    state.accounts.push({
      ...first,
      clientId: 'second-client',
      label: 'second account',
      credentials: { ...first.credentials, accessToken: 'second-access' },
    })
    const service = new ChatGptPlanService(memoryStore(state), {
      openBrowser: async (): Promise<void> => {},
      fetch: async (_input, init): Promise<Response> => {
        assert.deepEqual(init?.headers, { Authorization: 'Bearer second-access' })
        return Response.json({
          models: [
            { slug: 'visible-2', display_name: 'Second', visibility: 'list' },
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
            { slug: 'visible-1', display_name: 'First', visibility: 'list' },
          ],
        })
      },
    })
    await service.selectAccount('second-client')
    assert.deepEqual(await service.models(), {
      clientId: 'second-client',
      models: [
        { slug: 'visible-2', displayName: 'Second' },
        { slug: 'visible-1', displayName: 'First' },
      ],
    })
    assert.equal((await service.credentials('oaiapp_copse')).accessToken, 'access-before')
    assert.throws(
      () => runWithExplicitSettings({ values: {} }, () => service.credentials('oaiapp_copse')),
      /explicit settings profile/,
    )
  })

  it('clears local tokens on failed revocation but retains registration for reconnect', async () => {
    const store = memoryStore(savedState())
    const service = new ChatGptPlanService(store, {
      openBrowser: async (): Promise<void> => {},
      fetch: async (): Promise<Response> => {
        throw new Error('Offline')
      },
    })
    const signal = service.requestSignal('oaiapp_copse')
    const result = await service.signOut('oaiapp_copse')
    assert.equal(signal.aborted, true)
    assert.equal(result.revoked, false)
    assert.equal(result.status.accounts.at(0)?.connected, false)
    assert.equal(store.read().accounts.at(0)?.subject, 'user-1')
    await assert.rejects(service.credentials('oaiapp_copse'), /Reconnect/)
    assert.deepEqual(chatGptPlanStatus(store.read()), result.status)
  })
})
