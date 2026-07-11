import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import {
  clearCodexAgentSession,
  runCodexAgentFromSettings,
  type CreateCodex,
} from './codex-agent-client.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

interface StartCall {
  method: 'startThread' | 'resumeThread'
  id?: string | undefined
  workingDirectory?: string | undefined
  input?: unknown
}

/**
 * Build a fake Codex SDK client that records how it was driven and replays a
 * scripted event stream, so the adapter is exercised without spawning the real
 * `codex` CLI.
 */
interface FakeThread {
  readonly id: string | null
  runStreamed(input: unknown): Promise<{ events: AsyncGenerator<Record<string, unknown>> }>
}

function fakeCodex(
  events: Array<Record<string, unknown>>,
  calls: StartCall[],
  threadId = 'codex_thread_1',
): CreateCodex {
  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) yield event
  }
  const makeThread = (call: StartCall): FakeThread => ({
    get id(): string | null {
      return threadId
    },
    runStreamed(input: unknown): Promise<{ events: AsyncGenerator<Record<string, unknown>> }> {
      call.input = input
      return Promise.resolve({ events: gen() })
    },
  })
  const codex = {
    startThread(options: { workingDirectory?: string }): FakeThread {
      const call: StartCall = { method: 'startThread', workingDirectory: options.workingDirectory }
      calls.push(call)
      return makeThread(call)
    },
    resumeThread(id: string, options: { workingDirectory?: string }): FakeThread {
      const call: StartCall = {
        method: 'resumeThread',
        id,
        workingDirectory: options.workingDirectory,
      }
      calls.push(call)
      return makeThread(call)
    },
  }
  return () => codex as unknown as ReturnType<CreateCodex>
}

describe('runCodexAgentFromSettings', () => {
  const prevOpenai = process.env['OPENAI_API_KEY']
  const prevCodex = process.env['CODEX_API_KEY']

  afterEach(() => {
    if (prevOpenai === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = prevOpenai
    if (prevCodex === undefined) delete process.env['CODEX_API_KEY']
    else process.env['CODEX_API_KEY'] = prevCodex
  })

  it('requires an open project (working directory)', async () => {
    const restore = setWorkspaceRootForTest(null)
    process.env['OPENAI_API_KEY'] = 'sk-test'
    try {
      await assert.rejects(
        runCodexAgentFromSettings({
          threadId: 'thread-codex-no-dir',
          provider: 'codex',
          userPrompt: 'do something',
          signal: new AbortController().signal,
          onChunk: () => {},
        }),
        /Open a project folder before running Codex/,
      )
    } finally {
      restore()
    }
  })

  it('starts a Codex thread, streams items, reports usage, and persists the thread id', async () => {
    const restore = setWorkspaceRootForTest('/work/project')
    process.env['OPENAI_API_KEY'] = 'sk-test'
    clearCodexAgentSession('thread-codex-first')
    const calls: StartCall[] = []
    const chunks: StreamChunk[] = []
    try {
      const result = await runCodexAgentFromSettings(
        {
          threadId: 'thread-codex-first',
          provider: 'codex',
          userPrompt: 'fix the bug',
          signal: new AbortController().signal,
          onChunk: (c) => chunks.push(c),
        },
        {
          createCodex: fakeCodex(
            [
              { type: 'thread.started', thread_id: 'codex_thread_1' },
              {
                type: 'item.completed',
                item: { id: 'a1', type: 'agent_message', text: 'Fixed it.' },
              },
              {
                type: 'turn.completed',
                usage: { input_tokens: 12, output_tokens: 34 },
              },
            ],
            calls,
          ),
        },
      )

      assert.equal(calls.length, 1)
      const call = calls[0]
      assert.ok(call)
      assert.equal(call.method, 'startThread')
      assert.equal(call.workingDirectory, '/work/project')

      const notice = chunks.find((c) => c.type === 'text')
      assert.ok(notice && 'text' in notice)
      assert.match(notice.text, /Running Codex locally/)

      const usage = chunks.find((c) => c.type === 'usage')
      assert.ok(usage && 'inputTokens' in usage)
      assert.equal(usage.inputTokens, 12)
      assert.equal(usage.outputTokens, 34)

      assert.equal(result.assistantText, 'Fixed it.')
      assert.equal(result.inputTokens, 12)
      assert.equal(result.outputTokens, 34)

      const session = storageGet('codex-agent-session:thread-codex-first') as {
        threadId?: string
        workingDirectory?: string
      } | null
      assert.ok(session)
      assert.equal(session.threadId, 'codex_thread_1')
      assert.equal(session.workingDirectory, '/work/project')
    } finally {
      restore()
    }
  })

  it('resumes the persisted thread on a follow-up in the same workspace', async () => {
    const restore = setWorkspaceRootForTest('/work/project')
    process.env['OPENAI_API_KEY'] = 'sk-test'
    storageSet('codex-agent-session:thread-codex-reuse', {
      v: 1,
      provider: 'codex',
      threadId: 'codex_thread_existing',
      workingDirectory: '/work/project',
    })
    const calls: StartCall[] = []
    const chunks: StreamChunk[] = []
    try {
      await runCodexAgentFromSettings(
        {
          threadId: 'thread-codex-reuse',
          provider: 'codex',
          userPrompt: 'now add a test',
          signal: new AbortController().signal,
          onChunk: (c) => chunks.push(c),
          priorMessages: [{ role: 'user', content: 'earlier context' }],
        },
        {
          createCodex: fakeCodex(
            [
              { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Added.' } },
              { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
            ],
            calls,
            'codex_thread_existing',
          ),
        },
      )

      assert.equal(calls.length, 1)
      const call = calls[0]
      assert.ok(call)
      assert.equal(call.method, 'resumeThread')
      assert.equal(call.id, 'codex_thread_existing')
      // A resumed thread already holds history, so the follow-up sends only the
      // new message — no context preamble prepended.
      assert.equal(call.input, 'now add a test')

      const notice = chunks.find((c) => c.type === 'text')
      assert.ok(notice && 'text' in notice)
      assert.match(notice.text, /Continuing with Codex/)
    } finally {
      restore()
    }
  })
})
