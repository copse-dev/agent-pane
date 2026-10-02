import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { clearManagedAgentSession, runManagedAgentFromSettings } from './managed-agents-client.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { expectRecord } from '@shared/unknown-value.ts'
import { storageGet, storageSet } from '../storage/storage.ts'

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

/**
 * Mock of the Managed Agents API surface a single run touches. `sessionUsage`
 * supplies the cumulative `usage` object returned by GET /v1/sessions/{id}.
 */
function mockManagedAgentsApi(
  requests: RecordedRequest[],
  sessionUsage: () => unknown = () => ({ input_tokens: 5, output_tokens: 7 }),
): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const path = new URL(href).pathname
    const body =
      typeof init?.body === 'string' ? expectRecord(JSON.parse(init.body) as unknown) : null
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
      return jsonResponse({ usage: sessionUsage() })
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
      assert.equal(agentCreate.body['model'], 'claude-opus-4-8')
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

  it('passes a selected Managed Agents model id on create', async () => {
    const restoreWorkspace = setWorkspaceRootForTest(null)
    clearManagedAgentSession('thread-managed-model')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    const requests: RecordedRequest[] = []
    try {
      await runManagedAgentFromSettings({
        threadId: 'thread-managed-model',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        userPrompt: 'use sonnet',
        signal: new AbortController().signal,
        onChunk: () => {},
        fetchImpl: mockManagedAgentsApi(requests),
      })
      const agentCreate = requests.find((r) => r.method === 'POST' && r.path === '/v1/agents')
      assert.equal(agentCreate?.body?.['model'], 'claude-sonnet-4-6')
    } finally {
      restoreWorkspace()
    }
  })
})

describe('runManagedAgentFromSettings usage', () => {
  const prevAnthropicKey = process.env['ANTHROPIC_API_KEY']

  afterEach(() => {
    if (prevAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = prevAnthropicKey
  })

  async function runTurn(
    threadId: string,
    sessionUsage: unknown,
  ): Promise<{ result: { inputTokens: number; outputTokens: number }; usage: StreamChunk[] }> {
    const chunks: StreamChunk[] = []
    const result = await runManagedAgentFromSettings({
      threadId,
      provider: 'anthropic',
      userPrompt: 'next step',
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      fetchImpl: mockManagedAgentsApi([], () => sessionUsage),
    })
    return { result, usage: chunks.filter((c) => c.type === 'usage') }
  }

  it('folds session cache reads and per-TTL cache writes into input tokens', async () => {
    const restoreWorkspace = setWorkspaceRootForTest(null)
    clearManagedAgentSession('thread-managed-cache')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    try {
      const { result, usage } = await runTurn('thread-managed-cache', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 400,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 10 },
      })

      assert.deepEqual(usage, [
        {
          type: 'usage',
          model: 'remote-agent:anthropic#claude-opus-4-8',
          inputTokens: 560,
          outputTokens: 20,
          cacheReadTokens: 400,
          cacheCreationTokens: 60,
        },
      ])
      assert.equal(result.inputTokens, 560)
      assert.equal(result.outputTokens, 20)
      const persisted = expectRecord(storageGet('managed-agent-session:thread-managed-cache'))
      assert.equal(persisted['usageInput'], 100)
      assert.equal(persisted['usageCacheRead'], 400)
      assert.equal(persisted['usageCacheCreation'], 60)
    } finally {
      restoreWorkspace()
    }
  })

  it('reports only the per-turn cache delta on a follow-up turn', async () => {
    const restoreWorkspace = setWorkspaceRootForTest(null)
    clearManagedAgentSession('thread-managed-cache-delta')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    try {
      await runTurn('thread-managed-cache-delta', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 400,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 10 },
      })
      const { result, usage } = await runTurn('thread-managed-cache-delta', {
        input_tokens: 130,
        output_tokens: 45,
        cache_read_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 10 },
      })

      assert.equal(usage.length, 1)
      const chunk = usage[0]
      assert.ok(chunk?.type === 'usage')
      assert.equal(chunk.inputTokens, 30 + 600 + 20)
      assert.equal(chunk.outputTokens, 25)
      assert.equal(chunk.cacheReadTokens, 600)
      assert.equal(chunk.cacheCreationTokens, 20)
      assert.equal(result.inputTokens, 650)
    } finally {
      restoreWorkspace()
    }
  })

  it('treats null cache fields as zero', async () => {
    const restoreWorkspace = setWorkspaceRootForTest(null)
    clearManagedAgentSession('thread-managed-cache-null')
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    try {
      const { usage } = await runTurn('thread-managed-cache-null', {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: null,
        cache_creation: null,
      })
      const chunk = usage[0]
      assert.ok(chunk?.type === 'usage')
      assert.equal(chunk.inputTokens, 12)
      assert.equal(chunk.cacheReadTokens, 0)
      assert.equal(chunk.cacheCreationTokens, 0)
    } finally {
      restoreWorkspace()
    }
  })

  it('baselines cache counters for a session persisted before cache tracking', async () => {
    const restoreWorkspace = setWorkspaceRootForTest(null)
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    // Shape written before cache counters existed: usageInput is fresh input.
    storageSet('managed-agent-session:thread-managed-cache-legacy', {
      v: 1,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      sessionId: 'sess_1',
      agentId: 'agent_1',
      environmentId: 'env_1',
      hasRepo: false,
      usageInput: 100,
      usageOutput: 20,
    })
    try {
      const first = await runTurn('thread-managed-cache-legacy', {
        input_tokens: 140,
        output_tokens: 30,
        cache_read_input_tokens: 5000,
        cache_creation: { ephemeral_5m_input_tokens: 800 },
      })
      // The session's whole cache history is not charged to this one turn.
      const firstChunk = first.usage[0]
      assert.ok(firstChunk?.type === 'usage')
      assert.equal(firstChunk.inputTokens, 40)
      assert.equal(firstChunk.cacheReadTokens, 0)
      assert.equal(firstChunk.cacheCreationTokens, 0)

      const second = await runTurn('thread-managed-cache-legacy', {
        input_tokens: 150,
        output_tokens: 35,
        cache_read_input_tokens: 5600,
        cache_creation: { ephemeral_5m_input_tokens: 830 },
      })
      const secondChunk = second.usage[0]
      assert.ok(secondChunk?.type === 'usage')
      assert.equal(secondChunk.inputTokens, 10 + 600 + 30)
      assert.equal(secondChunk.cacheReadTokens, 600)
      assert.equal(secondChunk.cacheCreationTokens, 30)
    } finally {
      restoreWorkspace()
      clearManagedAgentSession('thread-managed-cache-legacy')
    }
  })
})
