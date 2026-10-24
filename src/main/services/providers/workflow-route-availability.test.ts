import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { runWithExplicitSettings } from '../storage/settings-context.ts'
import { assertWorkflowRouteAvailable } from './workflow-route-availability.ts'
import { getChatGptPlanService } from './chatgpt-plan-service.ts'
import { resolveWorkflowModel } from './workflow-models.ts'
import { invalidateLmStudioModelsCache } from './lm-studio-models.ts'
import { invalidateOpenAiModelAvailability } from './openai-model-availability.ts'
import { clearProviderKeyStatusCache } from './provider-key-status.ts'

const originalFetch = globalThis.fetch
const originalMock = process.env['COPSE_PANEL_MOCK_LLM']

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
  else process.env['COPSE_PANEL_MOCK_LLM'] = originalMock
  invalidateLmStudioModelsCache()
  invalidateOpenAiModelAvailability()
  clearProviderKeyStatusCache()
})

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
}

describe('desktop workflow route preflight', () => {
  it('resolves a configured worker against a real local HTTP catalog without inference', async (t) => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    const requests: string[] = []
    const server = createServer((request, reply) => {
      requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
      reply.setHeader('content-type', 'application/json')
      reply.end(JSON.stringify({ data: [{ id: 'worker' }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          }),
        ),
    )
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await runWithExplicitSettings(
      {
        values: {
          roleModels: { coder: 'fixture:worker' },
          extraProviders: [
            {
              slug: 'fixture',
              label: 'Fixture',
              baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
              models: [{ id: 'worker' }],
            },
          ],
          modelParameters: { 'fixture:worker': { reasoning: 'high' } },
        },
      },
      async () => {
        const result = await resolveWorkflowModel(
          { role: 'coder', maxReasoning: 'low' },
          new AbortController().signal,
        )
        assert.equal(result.model, 'fixture:worker')
        assert.equal(result.parameters.reasoning, 'low')
        assert.equal(result.requiresSpendApproval, false)
      },
    )
    assert.deepEqual(requests, ['GET /v1/models'])
  })

  it('honours the guarded reviewer setting even when renderer role assignments disagree', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    await runWithExplicitSettings(
      {
        values: {
          roleModels: { reviewer: 'gpt-5', coder: 'auto:role:reviewer' },
          reviewModel: 'claude-sonnet-4-6',
        },
      },
      async () => {
        const result = await resolveWorkflowModel({ role: 'coder' }, new AbortController().signal)
        assert.equal(result.model, 'claude-sonnet-4-6')
      },
    )
  })

  it('checks maker policy even in mock mode before contacting any provider', async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    globalThis.fetch = (): Promise<Response> => {
      throw new Error('Must not contact a blocked maker')
    }
    await runWithExplicitSettings({ values: { blockedModelMakers: ['xai'] } }, async () => {
      await assert.rejects(
        assertWorkflowRouteAvailable('openrouter:x-ai/grok-4.5'),
        /xAI models are blocked/,
      )
    })
  })

  it('never reinterprets a subscription, remote agent or deleted provider route as an API model', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    await runWithExplicitSettings(
      { values: {}, apiKeys: { anthropic: 'sk-ant-fake' } },
      async () => {
        for (const model of [
          'acp:claude-code#opus',
          'remote-agent:openai',
          'plugin-model:pack:worker',
          'removed:model',
        ]) {
          await assert.rejects(
            assertWorkflowRouteAvailable(model),
            /not a callable|no longer configured/,
          )
        }
        await assert.rejects(
          assertWorkflowRouteAvailable('chatgpt-plan:missing#gpt-5'),
          /plan connection is unavailable/,
        )
      },
    )
  })

  it('rejects batch-only selections before provider discovery, in mock mode too', async () => {
    for (const mock of [false, true]) {
      if (mock) process.env['COPSE_PANEL_MOCK_LLM'] = '1'
      else delete process.env['COPSE_PANEL_MOCK_LLM']
      await runWithExplicitSettings({ values: {} }, async () => {
        await assert.rejects(
          assertWorkflowRouteAvailable('openrouter:minimax/minimax-m3:batch'),
          /Batch-only/,
        )
      })
    }
  })

  it('keeps a connected native subscription route and refuses unadvertised plan models', async (t) => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    const service = getChatGptPlanService()
    t.mock.method(service, 'status', () => ({
      accounts: [{ clientId: 'account', label: 'Plan', connected: true, planEnabled: true }],
      activeClientId: 'account',
    }))
    t.mock.method(service, 'models', () =>
      Promise.resolve({ clientId: 'account', models: [{ slug: 'gpt-5', displayName: 'GPT-5' }] }),
    )
    await runWithExplicitSettings(
      { values: {}, apiKeys: { openai: 'sk-must-not-use' } },
      async () => {
        const result = await resolveWorkflowModel(
          { role: 'coder', model: 'chatgpt-plan:account#gpt-5' },
          new AbortController().signal,
        )
        assert.equal(result.model, 'chatgpt-plan:account#gpt-5')
        await assert.rejects(
          assertWorkflowRouteAvailable('chatgpt-plan:account#missing'),
          /does not advertise/,
        )
      },
    )
  })

  it('requires a valid key and account-advertised OpenAI model without making inference calls', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    const calls: string[] = []
    globalThis.fetch = (input): Promise<Response> => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(response({ data: [{ id: 'gpt-5' }] }))
    }
    await runWithExplicitSettings({ values: {}, apiKeys: { openai: 'sk-fake' } }, async () => {
      await assertWorkflowRouteAvailable('gpt-5')
      await assert.rejects(assertWorkflowRouteAvailable('gpt-6-astra'), /does not advertise/)
    })
    assert.ok(calls.length > 0)
    assert.ok(calls.every((url) => url === 'https://api.openai.com/v1/models'))
  })

  it('treats an unverifiable key as usable but refuses a rejected one', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    let status = 503
    globalThis.fetch = (): Promise<Response> => Promise.resolve(new Response('', { status }))
    await runWithExplicitSettings(
      { values: {}, apiKeys: { anthropic: 'sk-ant-fake' } },
      async () => {
        await assertWorkflowRouteAvailable('claude-sonnet-4-6')
        clearProviderKeyStatusCache()
        status = 401
        await assert.rejects(
          assertWorkflowRouteAvailable('claude-sonnet-4-6'),
          /rejected its configured key/,
        )
      },
    )
  })

  it('rejects missing credentials even if another provider has a key', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    await runWithExplicitSettings(
      { values: {}, apiKeys: { anthropic: 'sk-ant-fake' } },
      async () => {
        await assert.rejects(assertWorkflowRouteAvailable('gpt-5'), /No validated key for openai/)
      },
    )
  })

  it('checks advertised local chat models and rejects embeddings or an offline catalog', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(response({ data: [{ id: 'qwen-chat' }, { id: 'text-embedding-test' }] }))
    await runWithExplicitSettings(
      { values: { localServerUrl: 'http://localhost:1234/v1' } },
      async () => {
        await assertWorkflowRouteAvailable('lmstudio:qwen-chat')
        await assert.rejects(
          assertWorkflowRouteAvailable('lmstudio:text-embedding-test'),
          /unavailable/,
        )
        await assert.rejects(assertWorkflowRouteAvailable('lmstudio:missing'), /unavailable/)
        invalidateLmStudioModelsCache()
        globalThis.fetch = (): Promise<Response> =>
          Promise.resolve(new Response('', { status: 503 }))
        await assert.rejects(assertWorkflowRouteAvailable('lmstudio:qwen-chat'), /unavailable/)
      },
    )
  })

  it('requires an available configured local provider and uses only its own credential', async () => {
    delete process.env['COPSE_PANEL_MOCK_LLM']
    const headers: Array<HeadersInit | undefined> = []
    globalThis.fetch = (_input, init): Promise<Response> => {
      headers.push(init?.headers)
      return Promise.resolve(response({ data: [{ id: 'worker' }] }))
    }
    await runWithExplicitSettings(
      {
        values: {
          extraProviders: [
            {
              slug: 'my-local',
              baseUrl: 'http://localhost:4321/v1',
              label: 'Local',
              models: [{ id: 'worker' }],
            },
          ],
        },
        apiKeys: { lmstudio: 'do-not-send-this' },
      },
      async () => {
        await assertWorkflowRouteAvailable('my-local:worker')
        await assert.rejects(assertWorkflowRouteAvailable('my-local:missing'), /shortlist/)
        globalThis.fetch = (): Promise<Response> =>
          Promise.resolve(new Response('', { status: 503 }))
        await assert.rejects(assertWorkflowRouteAvailable('my-local:worker'), /unavailable/)
      },
    )
    assert.ok(headers.every((value) => !new Headers(value).has('authorization')))
  })
})
