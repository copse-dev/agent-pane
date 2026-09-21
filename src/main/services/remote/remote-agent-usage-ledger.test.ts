import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import { isRecord, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { createAgentChunkSink } from '../agent-chunk-sink.ts'
import { getUsageSummary } from '../storage/usage-ledger.ts'
import { storageSet } from '../storage/storage.ts'
import { USAGE_EVENTS_STORAGE_KEY } from '@shared/usage/usage-event.ts'
import { runRemoteAgentFromSettings, clearRemoteAgentSession } from './remote-agent-client.ts'
import { runManagedAgentFromSettings, clearManagedAgentSession } from './managed-agents-client.ts'

function noopHost(): AgentHost<StreamChunk> {
  return { emit: () => undefined }
}

afterEach(() => {
  storageSet('projects', [])
  storageSet('activeProjectId', null)
  clearRemoteAgentSession('thread-cursor-usage')
  clearManagedAgentSession('thread-managed-usage')
  clearRemoteAgentSession('thread-cursor-cancel-usage')
  clearManagedAgentSession('thread-managed-cancel-usage')
})

describe('cloud agent runs reach the usage ledger', () => {
  it('records a ledger row for a Cursor Cloud Agent follow-up run', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('remote-agent-session:thread-cursor-usage', {
      v: 1,
      provider: 'cursor',
      baseUrl: 'https://api.cursor.com',
      agentId: 'agent-usage-1',
      url: 'https://cursor.com/agents/agent-usage-1',
    })
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(href)
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.pathname === '/v1/agents/agent-usage-1/runs') {
        return new Response(
          JSON.stringify({ run: { id: 'run-usage-1', agentId: 'agent-usage-1' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (method === 'GET' && url.pathname === '/v1/agents/agent-usage-1/runs/run-usage-1/stream') {
        const body =
          'id: 1\nevent: result\ndata: {"status":"FINISHED","text":"Done."}\n\n' +
          'event: done\ndata: {}\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (method === 'GET' && url.pathname === '/v1/agents/agent-usage-1/usage') {
        return new Response(
          JSON.stringify({
            runs: [{ id: 'run-usage-1', usage: { inputTokens: 4200, outputTokens: 900 } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (method === 'GET' && url.pathname === '/v1/agents/agent-usage-1/artifacts') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }

    try {
      const sink = createAgentChunkSink('thread-cursor-usage', noopHost())
      const result = await runRemoteAgentFromSettings({
        threadId: 'thread-cursor-usage',
        provider: 'cursor',
        userPrompt: 'fix the flaky test',
        signal: new AbortController().signal,
        onChunk: sink,
        fetchImpl,
      })

      assert.equal(result.inputTokens, 4200)
      assert.equal(result.outputTokens, 900)

      const summary = await getUsageSummary()
      assert.equal(
        summary.ledgerEventCount,
        1,
        'the cloud agent run should append one ledger event',
      )
      const row = summary.day.cloudModels.find((m) => m.model === 'remote-agent:cursor')
      assert.ok(row, 'expected a remote-agent:cursor row in the cloud usage table')
      assert.equal(row.inputTokens, 4200)
      assert.equal(row.outputTokens, 900)
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })

  it('records a ledger row for a Claude Managed Agents (Anthropic) follow-up run', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('managed-agent-session:thread-managed-usage', {
      v: 1,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      sessionId: 'session-usage-1',
      agentId: 'agent-managed-1',
      environmentId: 'env-1',
      usageInput: 0,
      usageOutput: 0,
      hasRepo: false,
    })
    const prevKey = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'test-key'

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(href)
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.pathname === '/v1/sessions/session-usage-1/events') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && url.pathname === '/v1/sessions/session-usage-1/events/stream') {
        const body =
          'data: {"type":"agent.message","content":[{"type":"text","text":"Done."}]}\n\n' +
          'data: {"type":"session.status_idle","stop_reason":{"type":"end_turn"}}\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (method === 'GET' && url.pathname === '/v1/sessions/session-usage-1') {
        return new Response(JSON.stringify({ usage: { input_tokens: 3000, output_tokens: 500 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }

    try {
      const sink = createAgentChunkSink('thread-managed-usage', noopHost())
      const result = await runManagedAgentFromSettings({
        threadId: 'thread-managed-usage',
        provider: 'anthropic',
        userPrompt: 'fix the flaky test',
        signal: new AbortController().signal,
        onChunk: sink,
        fetchImpl,
      })

      assert.equal(result.inputTokens, 3000)
      assert.equal(result.outputTokens, 500)

      const summary = await getUsageSummary()
      assert.equal(
        summary.ledgerEventCount,
        1,
        'the cloud agent run should append one ledger event',
      )
      const row = summary.day.cloudModels.find((m) => m.model.startsWith('remote-agent:anthropic'))
      assert.ok(row, 'expected a remote-agent:anthropic row in the cloud usage table')
      assert.equal(row.inputTokens, 3000)
      assert.equal(row.outputTokens, 500)
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prevKey
    }
  })

  it('still records a ledger row when a Cursor run is cancelled mid-stream (Stop / Send now)', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('remote-agent-session:thread-cursor-cancel-usage', {
      v: 1,
      provider: 'cursor',
      baseUrl: 'https://api.cursor.com',
      agentId: 'agent-cancel-1',
    })
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    const controller = new AbortController()
    let cancelCalls = 0

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(href)
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.pathname === '/v1/agents/agent-cancel-1/runs') {
        return new Response(JSON.stringify({ run: { id: 'run-cancel-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (
        method === 'GET' &&
        url.pathname === '/v1/agents/agent-cancel-1/runs/run-cancel-1/stream'
      ) {
        // Abort once the stream is open, mirroring how Stop / Send now cancels
        // a live cloud agent turn mid-request.
        queueMicrotask(() => {
          controller.abort()
        })
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'))
          }
          if (init?.signal?.aborted) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (
        method === 'POST' &&
        url.pathname === '/v1/agents/agent-cancel-1/runs/run-cancel-1/cancel'
      ) {
        cancelCalls += 1
        return new Response(null, { status: 200 })
      }
      if (method === 'GET' && url.pathname === '/v1/agents/agent-cancel-1/usage') {
        return new Response(
          JSON.stringify({
            runs: [{ id: 'run-cancel-1', usage: { inputTokens: 1800, outputTokens: 220 } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }

    try {
      const sink = createAgentChunkSink('thread-cursor-cancel-usage', noopHost())
      const result = await runRemoteAgentFromSettings({
        threadId: 'thread-cursor-cancel-usage',
        provider: 'cursor',
        userPrompt: 'do something long-running',
        signal: controller.signal,
        onChunk: sink,
        fetchImpl,
      })

      assert.equal(cancelCalls, 1, 'expected the run to be cancelled upstream')
      assert.equal(result.inputTokens, 1800)
      assert.equal(result.outputTokens, 220)

      const summary = await getUsageSummary()
      assert.equal(
        summary.ledgerEventCount,
        1,
        'a cancelled cloud agent run that already billed tokens should still reach the ledger',
      )
      const row = summary.day.cloudModels.find((m) => m.model === 'remote-agent:cursor')
      assert.ok(row, 'expected a remote-agent:cursor row for the cancelled run')
      assert.equal(row.inputTokens, 1800)
      assert.equal(row.outputTokens, 220)
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })

  it('still records a ledger row when a Claude Managed Agents run is interrupted mid-stream', async () => {
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])
    storageSet('managed-agent-session:thread-managed-cancel-usage', {
      v: 1,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      sessionId: 'session-cancel-1',
      agentId: 'agent-managed-cancel-1',
      environmentId: 'env-cancel-1',
      usageInput: 0,
      usageOutput: 0,
      hasRepo: false,
    })
    const prevKey = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    const controller = new AbortController()
    let interruptCalls = 0

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(href)
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.pathname === '/v1/sessions/session-cancel-1/events') {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        const parsed: unknown = bodyText ? JSON.parse(bodyText) : null
        const events = isRecord(parsed) ? recordArrayOrEmpty(parsed['events']) : []
        if (events.some((e) => e['type'] === 'user.interrupt')) interruptCalls += 1
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && url.pathname === '/v1/sessions/session-cancel-1/events/stream') {
        queueMicrotask(() => {
          controller.abort()
        })
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'))
          }
          if (init?.signal?.aborted) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (method === 'GET' && url.pathname === '/v1/sessions/session-cancel-1') {
        return new Response(JSON.stringify({ usage: { input_tokens: 1500, output_tokens: 300 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }

    try {
      const sink = createAgentChunkSink('thread-managed-cancel-usage', noopHost())
      await assert.rejects(
        runManagedAgentFromSettings({
          threadId: 'thread-managed-cancel-usage',
          provider: 'anthropic',
          userPrompt: 'do something long-running',
          signal: controller.signal,
          onChunk: sink,
          fetchImpl,
        }),
      )

      assert.equal(interruptCalls, 1, 'expected the session to be interrupted upstream')

      const summary = await getUsageSummary()
      assert.equal(
        summary.ledgerEventCount,
        1,
        'an interrupted cloud agent run that already billed tokens should still reach the ledger',
      )
      const row = summary.day.cloudModels.find((m) => m.model.startsWith('remote-agent:anthropic'))
      assert.ok(row, 'expected a remote-agent:anthropic row for the interrupted run')
      assert.equal(row.inputTokens, 1500)
      assert.equal(row.outputTokens, 300)
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prevKey
    }
  })
})
