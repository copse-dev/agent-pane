import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { deleteApiKey, setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { MockLLMProvider } from '@copse/llm/mock-provider.ts'
import { ChatGptPlanService, getChatGptPlanService } from './chatgpt-plan-service.ts'
import type { ChatGptPlanState } from './chatgpt-plan-store.ts'
import { HOST_INFERENCE_TARGET } from '../container-runtime/host-inference-wire.ts'
import {
  explainContainerModel,
  guestFacingEndpoint,
  resolveContainerProvider,
} from './container-provider.ts'

const CLAUDE_AGENT: AcpAgentConfig = {
  id: 'claude-acp',
  title: 'Claude',
  command: '/Users/me/.local/bin/claude-agent-acp',
  env: { ANTHROPIC_API_KEY: 'sk-ant-desktop' },
  enabled: true,
}
const CODEX_AGENT: AcpAgentConfig = {
  id: 'codex-acp',
  title: 'Codex',
  command: 'codex-acp',
  enabled: true,
}
const CURSOR_AGENT: AcpAgentConfig = {
  id: 'cursor',
  title: 'Cursor',
  command: 'cursor-agent',
  args: ['acp'],
  enabled: true,
}
const CUSTOM_AGENT: AcpAgentConfig = {
  id: 'my-own-agent',
  title: 'Mine',
  command: 'my-agent',
  enabled: true,
}

describe('resolveContainerProvider', () => {
  beforeEach(async () => {
    for (const slug of ['anthropic', 'openai', 'openrouter', 'lmstudio', 'gemini']) {
      deleteApiKey(slug)
    }
    await setSetting('localServerUrl', '')
    await setSetting('registeredAcpAgents', [])
    await setSetting('blockedModelMakers', [])
  })

  it('keeps local inference on the host for LAN and loopback endpoints', async () => {
    for (const url of ['http://models.lan:1234/v1', 'http://127.0.0.1:1234/v1']) {
      await setSetting('localServerUrl', url)
      const plan = await resolveContainerProvider('lmstudio:qwen3')
      assert.equal(plan.mode, 'host-inference')
      assert.equal(plan.apiKey, null)
      assert.deepEqual(plan.egress, [HOST_INFERENCE_TARGET])
      assert.ok(plan.hostInference)
      assert.ok(!JSON.stringify(plan).includes(url))
    }
  })

  it('refuses an endpoint that already names the host-local alias', async () => {
    assert.throws(() => guestFacingEndpoint('https://model.copse.internal/v1'), /is reserved/)
    await setSetting('localServerUrl', 'https://model.copse.internal:1234/v1')
    await assert.rejects(resolveContainerProvider('lmstudio:qwen3'), /is reserved/)
  })

  it('keeps every built-in cloud provider key and endpoint out of the run plan', async () => {
    for (const [slug, model] of [
      ['anthropic', 'claude-sonnet-4-6'],
      ['openai', 'gpt-5'],
      ['openrouter', 'openrouter:qwen/qwen3'],
    ]) {
      assert.ok(slug && model)
      const secret = `private-${slug}-secret`
      setApiKey(slug, secret)
      const plan = await resolveContainerProvider(model)
      assert.equal(plan.mode, 'host-inference')
      assert.equal(plan.apiKey, null)
      assert.deepEqual(plan.egress, [HOST_INFERENCE_TARGET])
      assert.ok(plan.hostInference)
      assert.ok(!JSON.stringify(plan).includes(secret))
    }
  })

  it('pins the API key and generation settings despite later Settings changes', async (t) => {
    setApiKey('openrouter', 'host-only-secret-before')
    await setSetting('modelParameters', {
      'openrouter:qwen/qwen3': { temperature: 0.2, maxOutputTokens: 16384 },
    })
    const plan = await resolveContainerProvider('openrouter:qwen/qwen3')
    assert.equal(plan.mode, 'host-inference')
    setApiKey('openrouter', 'host-only-secret-after')
    await setSetting('modelParameters', { 'openrouter:qwen/qwen3': { temperature: 0.8 } })
    let requests = 0
    t.mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
        requests++
        assert.equal(request.headers.get('authorization'), 'Bearer host-only-secret-before')
        const body = await request.text()
        assert.ok(!body.includes('host-only-secret-before'))
        assert.ok(body.includes('"temperature":0.2'))
        assert.ok(body.includes(`"max_tokens":${String(requests === 1 ? 16384 : 8192)}`))
        const payload = {
          id: 'pinned',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'qwen/qwen3',
          choices: [
            { index: 0, delta: { content: 'host-only-secret-before' }, finish_reason: 'stop' },
          ],
        }
        return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    )
    const provider = await plan.hostInference(30000, 'run-pinned')
    let output = ''
    for await (const chunk of provider.stream(
      [{ role: 'user', content: 'Hello host-only-secret-before' }],
      [],
    ))
      output += JSON.stringify(chunk)
    const smaller = await plan.hostInference(8192, 'run-pinned')
    for await (const chunk of smaller.stream([{ role: 'user', content: 'hello' }], []))
      output += JSON.stringify(chunk)
    assert.equal(requests, 2)
    assert.ok(!output.includes('host-only-secret-before'))
    assert.ok(output.includes('[REDACTED_SECRET]'))
    await setSetting('modelParameters', {})
  })

  it('pins ChatGPT generation settings while refreshing only the selected account', async (t) => {
    const model = 'chatgpt-plan:oaiapp_a#gpt-6.1-sol'
    let state: ChatGptPlanState = {
      hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
      activeClientId: 'oaiapp_a',
      accounts: ['a', 'b'].map((name) => ({
        clientId: `oaiapp_${name}`,
        label: name,
        subject: name,
        credentials: {
          accessToken: `access-${name}`,
          refreshToken: `refresh-${name}`,
          idToken: `id-${name}`,
          expiresAt: 0,
          scopes: ['chatgpt.tokens.use.direct'],
        },
      })),
    }
    let refreshes = 0
    const realService = new ChatGptPlanService(
      {
        read: (): ChatGptPlanState => structuredClone(state),
        write: (next): void => {
          state = structuredClone(next)
        },
      },
      {
        openBrowser: async (): Promise<void> => {},
        fetch: async (_input, init): Promise<Response> => {
          refreshes++
          assert.ok(init?.body instanceof URLSearchParams)
          assert.match(init.body.toString(), /refresh-a/)
          assert.ok(!init.body.toString().includes('refresh-b'))
          return Response.json({
            access_token: 'rotated-a',
            refresh_token: 'rotated-refresh-a',
            expires_in: 3600,
            token_type: 'Bearer',
          })
        },
      },
    )
    const service = getChatGptPlanService()
    t.mock.method(service, 'status', realService.status.bind(realService))
    t.mock.method(service, 'credentials', realService.credentials.bind(realService))
    t.mock.method(service, 'requestSignal', realService.requestSignal.bind(realService))
    await setSetting('modelParameters', { [model]: { reasoning: 'high' } })
    t.after(async () => {
      await setSetting('modelParameters', {})
    })
    const plan = await resolveContainerProvider(model, { threadId: 'pinned-thread' })
    assert.equal(plan.mode, 'host-inference')
    await setSetting('modelParameters', { [model]: { reasoning: 'low' } })
    await realService.selectAccount('oaiapp_b')
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.equal(request.url, 'https://api.openai.com/v1/responses')
      assert.equal(request.headers.get('authorization'), 'Bearer rotated-a')
      const body = await request.text()
      assert.ok(body.includes('"effort":"high"'))
      assert.ok(body.includes('oaiapp_a:pinned-thread:run-pinned'))
      calls++
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    for (const budget of [20000, 8000]) {
      const provider = await plan.hostInference(budget, 'run-pinned')
      for await (const chunk of provider.stream([{ role: 'user', content: 'hello' }], []))
        assert.ok(chunk)
    }
    assert.equal(refreshes, 1)
    assert.equal(calls, 2)
    // Preserve the supported model-free runtime override in the resolved path too.
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    try {
      assert.ok((await plan.hostInference(8000, 'run-mock')) instanceof MockLLMProvider)
    } finally {
      if (previousMock === undefined) Reflect.deleteProperty(process.env, 'COPSE_PANEL_MOCK_LLM')
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
    }
    await realService.signOut('oaiapp_a')
    const signedOut = await plan.hostInference(8000, 'run-pinned')
    await assert.rejects(async () => {
      for await (const chunk of signedOut.stream([{ role: 'user', content: 'hello' }], []))
        assert.ok(chunk)
    }, /sign|connect|abort/i)
    assert.equal(calls, 2)
  })

  it('refuses a cloud model with no key rather than starting a run that cannot talk', async () => {
    await assert.rejects(resolveContainerProvider('claude-sonnet-4-6'), /not configured/)
    await assert.rejects(resolveContainerProvider('gpt-5'), /not configured/)
  })

  it('refuses a model it cannot place', async () => {
    await assert.rejects(resolveContainerProvider('mystery-model'), /cannot resolve a provider/)
  })

  it('says why a remote or plugin agent cannot run in a container', async () => {
    // The picker offers these (greyed out), so the refusal has to explain
    // itself rather than read as an internal resolver miss: an agent signs in
    // as the user, and the guest is given no credentials by design.
    for (const model of ['remote-agent:anthropic#x', 'plugin-model:foo']) {
      await assert.rejects(resolveContainerProvider(model), /signed in as you|credentials/)
    }
  })

  describe('ACP agents', () => {
    it('enforces maker blocks before resolving an ACP harness', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      await setSetting('blockedModelMakers', ['anthropic'])
      setApiKey('anthropic', 'sk-ant-run')

      await assert.rejects(
        resolveContainerProvider('acp:claude-acp#claude-opus-5'),
        /Anthropic models are blocked/,
      )
      assert.deepEqual(await explainContainerModel('acp:claude-acp#claude-opus-5'), {
        reason:
          'Anthropic models are blocked in Settings → General → Models. Choose another model or remove that block.',
      })
    })

    it('runs a key-capable agent under its vendor key, on its catalogue domains', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      const plan = await resolveContainerProvider('acp:claude-acp#claude-opus-5')
      assert.equal(plan.mode, 'acp')
      // The full selection travels: the guest routes `acp:` as the desktop does.
      assert.equal(plan.model, 'acp:claude-acp#claude-opus-5')
      assert.equal(plan.apiKey, 'sk-ant-run')
      assert.equal(plan.harness.keyEnvName, 'ANTHROPIC_API_KEY')
      // Catalogue command, not the desktop's absolute path; no user env at all.
      assert.equal(plan.harness.agent.command, 'claude-agent-acp')
      assert.equal(plan.harness.agent.env, undefined)
      assert.equal(plan.harness.agent.sandbox, false)
      assert.ok(plan.egress.includes('*.anthropic.com:443'))
      assert.ok(plan.egress.includes('claude.ai:443'))
      assert.ok(!JSON.stringify(plan.harness).includes('sk-ant'))
    })

    it('refuses a key-capable agent without its key, naming the key', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      await assert.rejects(
        resolveContainerProvider('acp:claude-acp'),
        /needs an Anthropic API key in Settings/,
      )
      // Claude has no sign-in to carry, so the opt-in changes nothing.
      await assert.rejects(
        resolveContainerProvider('acp:claude-acp', { useAgentLogin: true }),
        /needs an Anthropic API key in Settings/,
      )
      assert.deepEqual(await explainContainerModel('acp:claude-acp'), {
        reason: 'needs an Anthropic API key in Settings',
      })
    })

    it('runs Codex on the desktop sign-in only when opted in, and offers it otherwise', async () => {
      await setSetting('registeredAcpAgents', [CODEX_AGENT])
      // Not opted in: refused, but the dialog is told the row would run on
      // the sign-in, so it can show the opt-in for it.
      await assert.rejects(
        resolveContainerProvider('acp:codex-acp'),
        /needs an OpenAI API key in Settings, or your Codex sign-in/,
      )
      assert.deepEqual(await explainContainerModel('acp:codex-acp'), {
        reason: null,
        loginOffered: { agentTitle: 'Codex' },
      })
      // Opted in: a plan with no key and the sign-in directories to carry.
      const plan = await resolveContainerProvider('acp:codex-acp', { useAgentLogin: true })
      assert.equal(plan.mode, 'acp')
      assert.equal(plan.apiKey, null)
      assert.deepEqual(plan.harness.login, { files: ['.codex/auth.json'] })
      assert.ok(plan.egress.includes('*.openai.com:443'))
      // With a key, the key wins and nothing is carried in.
      setApiKey('openai', 'sk-openai-run')
      const keyed = await resolveContainerProvider('acp:codex-acp', { useAgentLogin: true })
      assert.equal(keyed.mode, 'acp')
      assert.equal(keyed.apiKey, 'sk-openai-run')
      assert.equal(keyed.harness.login, undefined)
      assert.deepEqual(await explainContainerModel('acp:codex-acp'), { reason: null })
    })

    it('accepts a key from the environment, as the run would', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
      const previous = process.env['ANTHROPIC_API_KEY']
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-env'
      try {
        assert.deepEqual(await explainContainerModel('acp:claude-acp'), { reason: null })
        const plan = await resolveContainerProvider('acp:claude-acp')
        assert.equal(plan.mode, 'acp')
        assert.equal(plan.apiKey, 'sk-ant-from-env')
      } finally {
        if (previous === undefined) delete process.env['ANTHROPIC_API_KEY']
        else process.env['ANTHROPIC_API_KEY'] = previous
      }
    })

    it('explains a row with the short per-agent reason the dialog shows', async () => {
      await setSetting('registeredAcpAgents', [CLAUDE_AGENT, CURSOR_AGENT, CUSTOM_AGENT])
      assert.deepEqual(await explainContainerModel('acp:claude-acp#claude-opus-5'), {
        reason: 'needs an Anthropic API key in Settings',
      })
      assert.deepEqual(await explainContainerModel('acp:cursor'), {
        reason: 'signs in through a browser; no API-key path',
      })
      assert.deepEqual(await explainContainerModel('acp:my-own-agent'), {
        reason: 'not carried by the worker image',
      })
      assert.deepEqual(await explainContainerModel('acp:never-registered'), {
        reason: 'not configured in Settings',
      })
      assert.deepEqual(await explainContainerModel('remote-agent:anthropic#x'), {
        reason: 'not available in a container',
      })
      setApiKey('anthropic', 'sk-ant-run')
      assert.deepEqual(await explainContainerModel('acp:claude-acp#claude-opus-5'), {
        reason: null,
      })
    })

    it('refuses an agent that only signs in through a browser, whatever keys exist', async () => {
      await setSetting('registeredAcpAgents', [CURSOR_AGENT])
      setApiKey('anthropic', 'sk-ant-run')
      await assert.rejects(resolveContainerProvider('acp:cursor'), /signs in through a browser/)
    })

    it('refuses an agent the image does not carry', async () => {
      await setSetting('registeredAcpAgents', [CUSTOM_AGENT])
      await assert.rejects(
        resolveContainerProvider('acp:my-own-agent'),
        /not carried by the worker image/,
      )
    })

    it('refuses an agent that is not registered or is disabled', async () => {
      await assert.rejects(resolveContainerProvider('acp:claude-acp'), /not configured/)
      await setSetting('registeredAcpAgents', [{ ...CLAUDE_AGENT, enabled: false }])
      await assert.rejects(resolveContainerProvider('acp:claude-acp'), /not configured/)
    })
  })
})
