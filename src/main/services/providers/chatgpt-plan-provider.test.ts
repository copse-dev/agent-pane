import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { ChatGptPlanService } from './chatgpt-plan-service.ts'
import { createChatGptPlanProvider } from './chatgpt-plan-provider.ts'
import type { ChatGptPlanState } from './chatgpt-plan-store.ts'
import type { LLMProvider, LLMMessage } from '@shared/types'
import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'

const originalFetch = globalThis.fetch
const originalEnvironment = {
  OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
  OPENAI_ORG_ID: process.env['OPENAI_ORG_ID'],
  OPENAI_PROJECT_ID: process.env['OPENAI_PROJECT_ID'],
}
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function provider(): LLMProvider {
  let state: ChatGptPlanState = {
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    activeClientId: 'oaiapp_test',
    accounts: [
      {
        clientId: 'oaiapp_test',
        subject: 'user',
        label: 'Test account',
        credentials: {
          accessToken: 'oauth-access-secret',
          refreshToken: 'oauth-refresh-secret',
          idToken: 'oauth-id-secret',
          scopes: ['chatgpt.tokens.use.direct'],
          expiresAt: Date.now() + 3600_000,
        },
      },
    ],
  }
  const service = new ChatGptPlanService(
    {
      read: (): ChatGptPlanState => structuredClone(state),
      write: (next): void => {
        state = structuredClone(next)
      },
    },
    {
      fetch: async (): Promise<Response> => {
        throw new Error('Unexpected authentication request')
      },
      openBrowser: async (): Promise<void> => {},
    },
  )
  return createChatGptPlanProvider(
    service,
    { clientId: 'oaiapp_test', model: 'gpt-6.1-sol' },
    'chatgpt-plan:oaiapp_test#gpt-6.1-sol',
    {},
    'thread-test',
  )
}

async function collect(
  provider: LLMProvider,
  messages: LLMMessage[],
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    },
  ]))
    chunks.push(chunk)
  return chunks
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('native ChatGPT plan SDK transport', () => {
  it('pins the public endpoint despite ambient overrides, sends the OAuth bearer, and continues a tool chain', async () => {
    process.env['OPENAI_BASE_URL'] = 'https://unexpected.example/v1'
    process.env['OPENAI_ORG_ID'] = 'unrelated-api-organization'
    process.env['OPENAI_PROJECT_ID'] = 'unrelated-api-project'
    let requests = 0
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      assert.equal(url, 'https://api.openai.com/v1/responses')
      assert.ok(init)
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer oauth-access-secret')
      assert.equal(new Headers(init.headers).get('OpenAI-Organization'), null)
      assert.equal(new Headers(init.headers).get('OpenAI-Project'), null)
      assert.equal(init.redirect, 'error')
      assert.equal(typeof init.body, 'string')
      assert.ok(typeof init.body === 'string')
      const body = safeJsonParse(init.body, decodeWithSchema(z.record(z.string(), z.unknown())))
      assert.ok(body)
      bodies.push(body)
      requests++
      if (requests === 1)
        return sse([
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              namespace: 'copse',
              call_id: 'call-1',
              name: 'read_file',
              arguments: '{}',
            },
          },
          {
            type: 'response.completed',
            response: {
              output: [{ type: 'function_call' }],
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ])
      return sse([
        { type: 'response.output_text.delta', delta: 'Read the file.' },
        {
          type: 'response.completed',
          response: {
            output: [],
            usage: {
              input_tokens: 15,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 10 },
            },
          },
        },
      ])
    }
    const route = provider()
    const first = await collect(route, [
      { role: 'system', content: 'Use tools.' },
      { role: 'user', content: 'Inspect a file. oauth-refresh-secret' },
    ])
    assert.equal(first.find((chunk) => chunk.type === 'tool_call')?.type, 'tool_call')
    assert.ok(
      first.some(
        (chunk) => chunk.type === 'usage' && chunk.model === 'chatgpt-plan:oaiapp_test#gpt-6.1-sol',
      ),
    )
    const second = await collect(route, [
      { role: 'user', content: 'Inspect a file.' },
      { role: 'assistant', content: [{ id: 'call-1', name: 'read_file', args: {} }] },
      { role: 'tool', toolResults: [{ toolCallId: 'call-1', result: 'file contents' }] },
    ])
    assert.ok(second.some((chunk) => chunk.type === 'text' && chunk.text === 'Read the file.'))
    assert.equal(bodies.at(0)?.['store'], false)
    assert.equal(JSON.stringify(bodies).includes('oauth-refresh-secret'), false)
    assert.equal(JSON.stringify(bodies.at(1)).includes('function_call_output'), true)
    assert.equal(bodies.at(1)?.['previous_response_id'], undefined)
  })

  it('surfaces plan exhaustion without retries or API-key fallback and redacts diagnostics', async () => {
    let requests = 0
    globalThis.fetch = async (): Promise<Response> => {
      requests++
      return Response.json(
        {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'Limit reached oauth-access-secret',
            type: 'rate_limit_error',
          },
        },
        { status: 429 },
      )
    }
    await assert.rejects(
      collect(provider(), [{ role: 'user', content: 'hello' }]),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /ChatGPT plan usage limit reached/)
        assert.ok(error.cause instanceof Error)
        assert.equal(error.cause.message.includes('oauth-access-secret'), false)
        return true
      },
    )
    assert.equal(requests, 1)
  })
})
