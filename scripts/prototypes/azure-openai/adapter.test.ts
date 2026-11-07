import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { AzurePrototypeError, azureResponsesUrl, createAzurePrototype } from './adapter.mts'
import {
  completeEvents,
  eventResponse,
  fixtureDeployment,
  fixtureEndpoint,
  requestSchema,
  runAzureScenario,
} from './fixture.mts'

async function collect(
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream([{ role: 'user', content: 'Hello' }], [], signal))
    chunks.push(chunk)
  return chunks
}

function keyed(fetch: typeof globalThis.fetch): LLMProvider {
  return createAzurePrototype(
    {
      endpoint: fixtureEndpoint,
      deployment: fixtureDeployment,
      auth: { kind: 'api-key', key: 'synthetic-api-key' },
    },
    { fetch },
  )
}

test('Azure resource roots and v1 roots resolve to one fixed Responses endpoint', () => {
  for (const endpoint of [
    fixtureEndpoint,
    `${fixtureEndpoint}/openai/v1`,
    `${fixtureEndpoint}/openai/v1/`,
  ])
    assert.equal(azureResponsesUrl(endpoint), `${fixtureEndpoint}/openai/v1/responses`)
  assert.equal(
    azureResponsesUrl('https://team.services.ai.azure.com'),
    'https://team.services.ai.azure.com/openai/v1/responses',
  )
  for (const endpoint of [
    'not a URL',
    'http://team.openai.azure.com',
    'https://127.0.0.1',
    'https://team.openai.azure.com.attacker.example',
    'https://openai.azure.com',
    'https://team.openai.azure.com:8443',
    'https://user:secret@team.openai.azure.com',
    `${fixtureEndpoint}/openai/deployments/team`,
    `${fixtureEndpoint}?api-key=secret`,
    `${fixtureEndpoint}#secret`,
  ])
    assert.throws(() => azureResponsesUrl(endpoint), /HTTPS Azure/)
})

test('rejects invalid deployment names before touching credentials or transport', () => {
  for (const deployment of ['', 'a/b', 'a?b', 'a\nb', 'x'.repeat(129)]) {
    assert.throws(
      () =>
        createAzurePrototype(
          {
            endpoint: fixtureEndpoint,
            deployment,
            auth: {
              kind: 'entra',
              getToken: () => {
                throw new Error('must not resolve')
              },
            },
          },
          {
            fetch: () => {
              throw new Error('must not send')
            },
          },
        ),
      /deployment name/,
    )
  }
})

test('real SDK decodes fragmented UTF-8/SSE, tools, tool results and usage across credential renewal', async () => {
  assert.deepEqual(await runAzureScenario(), {
    deployment: fixtureDeployment,
    requests: 2,
    credentialResolutions: 2,
    rotatedCredential: true,
    replayedToolResult: true,
    text: 'Checked café. Done.',
    inputTokens: 40,
    outputTokens: 10,
    cacheReadTokens: 8,
  })
})

test('pins endpoint/deployment/auth, opts out of storage and disables redirects', async () => {
  const connection = {
    endpoint: fixtureEndpoint,
    deployment: fixtureDeployment,
    auth: { kind: 'api-key' as const, key: 'synthetic-original-key' },
  }
  let requests = 0
  const provider = createAzurePrototype(connection, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests++
      assert.equal(request.url, `${fixtureEndpoint}/openai/v1/responses`)
      assert.equal(request.method, 'POST')
      assert.equal(request.redirect, 'error')
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-original-key')
      assert.equal(request.headers.has('api-key'), false)
      const body = safeJsonParse(await request.text(), decodeWithSchema(requestSchema))
      assert.ok(body)
      assert.equal(body.model, fixtureDeployment)
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      return eventResponse(completeEvents(false))
    },
  })
  connection.endpoint = 'https://other.openai.azure.com'
  connection.deployment = 'other-deployment'
  connection.auth.key = 'other-key'
  await collect(provider)
  assert.equal(requests, 1)
})

test('renewable credential is resolved again on a safe pre-stream retry', async () => {
  let resolutions = 0
  const headers: Array<string | null> = []
  const provider = createAzurePrototype(
    {
      endpoint: fixtureEndpoint,
      deployment: fixtureDeployment,
      auth: {
        kind: 'entra',
        getToken: async () => ({
          token: `synthetic-${String(++resolutions)}`,
          expiresAt: Date.now() + 60_000,
        }),
      },
    },
    {
      fetch: async (input, init) => {
        headers.push(new Request(input, init).headers.get('authorization'))
        return headers.length === 1
          ? Response.json(
              { error: { message: 'busy' } },
              { status: 429, headers: { 'retry-after-ms': '0' } },
            )
          : eventResponse(completeEvents(false))
      },
    },
  )
  await collect(provider)
  assert.deepEqual(headers, ['Bearer synthetic-1', 'Bearer synthetic-2'])
})

test('expired/blank/failed credential resolution never sends a request or exposes the cause', async () => {
  for (const failure of ['expired', 'blank', 'throw']) {
    let resolutions = 0
    let requests = 0
    const provider = createAzurePrototype(
      {
        endpoint: fixtureEndpoint,
        deployment: fixtureDeployment,
        auth: {
          kind: 'entra',
          getToken: async () => {
            resolutions++
            if (failure === 'throw') throw new Error('sensitive identity diagnostic')
            return {
              token: failure === 'blank' ? '' : 'synthetic-token',
              expiresAt: failure === 'expired' ? 0 : Date.now() + 60_000,
            }
          },
        },
      },
      {
        fetch: async () => {
          requests++
          return eventResponse(completeEvents(false))
        },
      },
    )
    await assert.rejects(collect(provider), (error: unknown) => {
      assert.ok(error instanceof AzurePrototypeError)
      assert.equal(error.code, 'auth')
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(error.message, /sensitive|synthetic/)
      return true
    })
    assert.equal(requests, 0)
    assert.equal(resolutions, 1)
  }
})

test('HTTP errors are actionable and contain no upstream body, headers or cause', async () => {
  const cases: Array<[number, AzurePrototypeError['code'], number]> = [
    [401, 'auth', 1],
    [403, 'forbidden', 1],
    [404, 'deployment', 1],
    [429, 'quota', 4],
    [503, 'transport', 4],
  ]
  for (const [status, code, attempts] of cases) {
    let requests = 0
    const provider = keyed(async () => {
      requests++
      return Response.json(
        { error: { message: 'synthetic-api-key' } },
        {
          status,
          headers: { 'retry-after-ms': '0', 'x-request-id': 'synthetic-api-key' },
        },
      )
    })
    await assert.rejects(collect(provider), (error: unknown) => {
      assert.ok(error instanceof AzurePrototypeError)
      assert.equal(error.code, code)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(error.stack ?? '', /synthetic-api-key/)
      return true
    })
    assert.equal(requests, attempts)
  }
})

test('cancellation before a turn does not resolve credentials or send requests', async () => {
  const controller = new AbortController()
  controller.abort()
  let requests = 0
  const provider = keyed(async () => {
    requests++
    return eventResponse(completeEvents(false))
  })
  await assert.rejects(collect(provider, controller.signal), { name: 'AbortError' })
  assert.equal(requests, 0)
})

test('cancellation while waiting for identity returns promptly even if its SDK ignores abort', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<undefined>()
  const credential = Promise.withResolvers<{ token: string; expiresAt: number }>()
  let requests = 0
  const provider = createAzurePrototype(
    {
      endpoint: fixtureEndpoint,
      deployment: fixtureDeployment,
      auth: {
        kind: 'entra',
        getToken: () => {
          started.resolve(undefined)
          return credential.promise
        },
      },
    },
    {
      fetch: async () => {
        requests++
        return eventResponse(completeEvents(false))
      },
    },
  )
  const result = collect(provider, controller.signal)
  await started.promise
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  credential.resolve({ token: 'late-synthetic-token', expiresAt: Date.now() + 60_000 })
  assert.equal(requests, 0)
})

test('cancellation during streaming reaches transport and never replays the turn', async () => {
  const controller = new AbortController()
  let requests = 0
  let cancelled = false
  const provider = keyed(async (input, init) => {
    requests++
    const request = new Request(input, init)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream): void {
          request.signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              stream.error(new DOMException('Cancelled', 'AbortError'))
            },
            { once: true },
          )
          stream.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
            ),
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  const chunks: ProviderStreamChunk[] = []
  await assert.rejects(
    async () => {
      for await (const chunk of provider.stream(
        [{ role: 'user', content: 'Hi' }],
        [],
        controller.signal,
      )) {
        chunks.push(chunk)
        controller.abort()
      }
    },
    { name: 'AbortError' },
  )
  assert.deepEqual(chunks, [{ type: 'text', text: 'partial' }])
  assert.equal(cancelled, true)
  assert.equal(requests, 1)
})

test('identity cancellation followed by rejection is consumed without leaking its diagnostic', async () => {
  const controller = new AbortController()
  const provider = createAzurePrototype(
    {
      endpoint: fixtureEndpoint,
      deployment: fixtureDeployment,
      auth: {
        kind: 'entra',
        getToken: () => {
          controller.abort()
          return Promise.reject(new Error('sensitive identity rejection'))
        },
      },
    },
    {
      fetch: () => {
        throw new Error('must not send')
      },
    },
  )
  await assert.rejects(collect(provider, controller.signal), { name: 'AbortError' })
})

test('truncated and failed streams preserve partial text without retrying or claiming success', async () => {
  for (const failed of [false, true]) {
    let requests = 0
    const provider = keyed(async () => {
      requests++
      return eventResponse([
        { type: 'response.output_text.delta', delta: 'partial' },
        ...(failed
          ? [
              {
                type: 'response.failed',
                response: { error: { code: 'server_error', message: 'synthetic-api-key' } },
              },
            ]
          : []),
      ])
    })
    const chunks: ProviderStreamChunk[] = []
    await assert.rejects(
      async () => {
        for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], []))
          chunks.push(chunk)
      },
      (error: unknown) => {
        assert.ok(error instanceof AzurePrototypeError)
        assert.doesNotMatch(error.message, /synthetic-api-key/)
        return true
      },
    )
    assert.deepEqual(chunks, [{ type: 'text', text: 'partial' }])
    assert.equal(requests, 1)
  }
})
