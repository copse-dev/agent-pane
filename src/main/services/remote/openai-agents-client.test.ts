import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk } from '@shared/types'
import { setApiKey, deleteApiKey } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import { runRemoteAgentFromSettings } from './remote-agent-client.ts'
import { clearOpenAiAgentSession } from './openai-agents-client.ts'

const page = (data: unknown[]): Response => Response.json({ data, has_more: false, last_id: null })

describe('OpenAI cloud adapter', () => {
  let root = ''
  let previousRoot: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-openai-test-'))
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('activeProjectId', 'project')
    setApiKey('openai', 'adapter-test-key')
  })
  afterEach(() => {
    clearOpenAiAgentSession('thread')
    storageSet('activeProjectId', null)
    deleteApiKey('openai')
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('dispatches OpenAI, saves its checkpoint in the thread, projects tools, and downloads a safely named artifact', async () => {
    let submitted = false
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      requests.push(url.pathname)
      assert.equal(url.origin, 'https://api.openai.com')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer adapter-test-key')
      if (url.pathname.endsWith('/events') && init?.method === 'GET')
        return new Response('', { headers: { 'Content-Type': 'text/event-stream' } })
      if (url.pathname.endsWith('/events')) {
        submitted = true
        return new Response(null, { status: 202 })
      }
      if (url.pathname.endsWith('/turns'))
        return page(
          submitted ? [{ id: 'turn', status: 'completed', subagent_id: null, error: null }] : [],
        )
      if (url.pathname.endsWith('/items'))
        return page([
          {
            id: 'command',
            turn_id: 'turn',
            type: 'command_execution',
            status: 'completed',
            command: 'python hello.py',
            output: '4',
            exit_code: 0,
          },
          {
            id: 'reply',
            turn_id: 'turn',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'The script printed 4.' }],
          },
          {
            id: 'tool',
            turn_id: 'turn',
            type: 'function_call_output',
            output: { type: 'json', value: { ok: true } },
          },
          { id: 'reasoning', turn_id: 'turn', type: 'reasoning', status: null, summary: [] },
        ])
      if (url.pathname.endsWith('/artifacts'))
        return page([
          { id: '../../escape', turn_id: 'turn', path: '../../escape.txt', size_bytes: 4 },
        ])
      if (url.pathname.endsWith('/content')) return new Response('file')
      return Response.json({
        id: 'session',
        status: 'idle',
        usage: { input_tokens: 12, output_tokens: 3 },
      })
    }
    const chunks: StreamChunk[] = []
    const result = await runRemoteAgentFromSettings({
      threadId: 'thread',
      provider: 'openai',
      userPrompt: 'Run a script',
      signal: AbortSignal.timeout(10_000),
      fetchImpl,
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    assert.match(result.assistantText, /printed 4/)
    assert.equal(result.inputTokens, 12)
    assert.ok(
      chunks.some((chunk) => chunk.type === 'tool_call' && chunk.toolCall.name === 'run_shell'),
    )
    assert.ok(
      chunks.some(
        (chunk) => chunk.type === 'tool_result' && chunk.result === '4' && !chunk.isError,
      ),
    )
    const match = result.assistantText.match(/\[Download artifact \(4 bytes\)\]\(([^)]+)\)/)
    assert.ok(match?.[1])
    assert.ok(match[1].startsWith(join(root, 'project', 'thread', 'blobs')))
    assert.equal(readFileSync(match[1], 'utf8'), 'file')
    const checkpoint = readFileSync(
      join(threadDirectoryPath('project', 'thread'), 'openai-agent-session.json'),
      'utf8',
    )
    assert.ok(!checkpoint.includes('adapter-test-key'))
    assert.equal(storageGet('openai-agent-owner:thread'), 'project')
    assert.equal(requests.filter((path) => path === '/v1/agents/sessions').length, 1)

    setApiKey('openai', 'different-key')
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: 'follow-up',
        signal: AbortSignal.timeout(1_000),
        fetchImpl,
        onChunk: () => {},
      }),
      /different OpenAI key/,
    )
    setApiKey('openai', 'adapter-test-key')
    writeFileSync(
      join(threadDirectoryPath('project', 'thread'), 'openai-agent-session.json'),
      '{broken',
    )
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: 'follow-up',
        signal: AbortSignal.timeout(1_000),
        fetchImpl,
        onChunk: () => {},
      }),
      /checkpoint/,
    )
  })
})
