import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { clearManagedAgentSession, runManagedAgentFromSettings } from './managed-agents-client.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

interface RecordedRequest {
  method: string
  path: string
  body: Record<string, unknown> | null
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Mock of the Managed Agents API surface a single first-turn run touches. */
function mockManagedAgentsApi(requests: RecordedRequest[]): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const path = new URL(href).pathname
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    requests.push({ method, path, body })

    if (method === 'POST' && path === '/v1/agents') return jsonResponse({ id: 'agent_1' })
    if (method === 'POST' && path === '/v1/environments') return jsonResponse({ id: 'env_1' })
    if (method === 'POST' && path === '/v1/sessions') return jsonResponse({ id: 'sess_1' })
    if (method === 'GET' && path === '/v1/sessions/sess_1/events/stream') {
      return sseResponse([
        { type: 'agent.message', content: [{ type: 'text', text: 'Hello from the sandbox' }] },
        { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
      ])
    }
    if (method === 'POST' && path === '/v1/sessions/sess_1/events') return jsonResponse({})
    if (method === 'GET' && path === '/v1/sessions/sess_1') {
      return jsonResponse({ usage: { input_tokens: 5, output_tokens: 7 } })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }
  return impl
}

describe('runManagedAgentFromSettings without a repository', () => {
  const prevAnthropicKey = process.env['ANTHROPIC_API_KEY']

  afterEach(() => {
    if (prevAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = prevAnthropicKey
  })

  it('creates a repo-less session and skips GitHub tooling and token', async () => {
    // No workspace / active project → no GitHub repository can be resolved.
    // Notably, no GitHub token is required on this path.
    const restoreWorkspace = setWorkspaceRootForTest(null)
    // The session store persists across runs; start from a fresh thread.
    clearManagedAgentSession('thread-managed-no-repo')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    const requests: RecordedRequest[] = []
    const chunks: StreamChunk[] = []

    try {
      const result = await runManagedAgentFromSettings({
        threadId: 'thread-managed-no-repo',
        provider: 'anthropic',
        userPrompt: 'summarize this idea',
        signal: new AbortController().signal,
        onChunk: (chunk) => chunks.push(chunk),
        fetchImpl: mockManagedAgentsApi(requests),
      })

      const agentCreate = requests.find((r) => r.method === 'POST' && r.path === '/v1/agents')
      assert.ok(agentCreate?.body)
      assert.equal('mcp_servers' in agentCreate.body, false)
      assert.deepEqual(agentCreate.body['tools'], [{ type: 'agent_toolset_20260401' }])
      assert.match(String(agentCreate.body['system']), /No repository is attached/)

      const sessionCreate = requests.find((r) => r.method === 'POST' && r.path === '/v1/sessions')
      assert.ok(sessionCreate?.body)
      assert.deepEqual(sessionCreate.body['resources'], [])
      assert.equal(sessionCreate.body['title'], 'Copse session')

      const launchNotice = chunks.find((c) => c.type === 'text')
      assert.ok(launchNotice && 'text' in launchNotice)
      assert.match(launchNotice.text, /no repository attached/)

      assert.equal(result.assistantText, 'Hello from the sandbox')
      assert.equal(result.inputTokens, 5)
      assert.equal(result.outputTokens, 7)
    } finally {
      restoreWorkspace()
    }
  })
})
