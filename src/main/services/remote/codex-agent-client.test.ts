import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { clearCodexAgentSession, runCodexAgentFromSettings } from './codex-agent-client.ts'
import { storageSet } from '../storage/storage.ts'
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

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('runCodexAgentFromSettings', () => {
  const prevKey = process.env['OPENAI_API_KEY']

  afterEach(() => {
    if (prevKey === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = prevKey
    storageSet('projects', [])
    storageSet('activeProjectId', null)
  })

  it('rejects a non-GitHub project with a Codex-specific error', async () => {
    // No workspace / active project → no repository can be resolved. Codex Cloud
    // has no repo-less mode, so a fresh run must reject before any network call.
    const restoreWorkspace = setWorkspaceRootForTest(null)
    clearCodexAgentSession('thread-codex-no-repo')
    process.env['OPENAI_API_KEY'] = 'sk-test'
    try {
      await assert.rejects(
        runCodexAgentFromSettings({
          threadId: 'thread-codex-no-repo',
          provider: 'codex',
          userPrompt: 'do something',
          signal: new AbortController().signal,
          onChunk: () => {},
          fetchImpl: () => {
            throw new Error('unexpected network call')
          },
        }),
        /needs a project backed by a GitHub remote/,
      )
    } finally {
      restoreWorkspace()
    }
  })

  it('reuses an existing task on a follow-up: new turn, stream, and usage', async () => {
    // Seed a prior session so the run takes the reuse path — no repository lookup,
    // just a new turn on the existing task.
    process.env['OPENAI_API_KEY'] = 'sk-test'
    storageSet('codex-agent-session:thread-codex-reuse', {
      v: 1,
      provider: 'codex',
      baseUrl: 'https://api.openai.com',
      taskId: 'task_1',
      url: 'https://chatgpt.com/codex/tasks/task_1',
    })

    const requests: RecordedRequest[] = []
    const chunks: StreamChunk[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const path = new URL(href).pathname
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
      requests.push({ method, path, body })

      if (method === 'POST' && path === '/v1/codex/tasks/task_1/turns') {
        return jsonResponse({ turn: { id: 'turn_2' } })
      }
      if (method === 'GET' && path === '/v1/codex/tasks/task_1/turns/turn_2/events') {
        return sseResponse([
          { event: 'response.output_text.delta', data: { delta: 'Hello from Codex' } },
          { event: 'response.completed', data: { response: { status: 'completed' } } },
        ])
      }
      if (method === 'GET' && path === '/v1/codex/tasks/task_1/turns/turn_2') {
        return jsonResponse({ usage: { input_tokens: 11, output_tokens: 22 } })
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    }

    const result = await runCodexAgentFromSettings({
      threadId: 'thread-codex-reuse',
      provider: 'codex',
      userPrompt: 'continue',
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      fetchImpl,
    })

    const turnCreate = requests.find(
      (r) => r.method === 'POST' && r.path === '/v1/codex/tasks/task_1/turns',
    )
    assert.ok(turnCreate?.body)
    // Follow-ups send only the new message — no repo, no context preamble.
    assert.equal('repo' in turnCreate.body, false)

    const launchNotice = chunks.find((c) => c.type === 'text')
    assert.ok(launchNotice && 'text' in launchNotice)
    assert.match(launchNotice.text, /Continuing on Codex Cloud Agent/)

    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && 'inputTokens' in usage)
    assert.equal(usage.inputTokens, 11)
    assert.equal(usage.outputTokens, 22)

    assert.equal(result.assistantText, 'Hello from Codex')
    assert.equal(result.inputTokens, 11)
    assert.equal(result.outputTokens, 22)
  })
})
