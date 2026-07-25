import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from './internal-utils.ts'
import { runSubagent, CI_INVESTIGATOR_SYSTEM_PROMPT } from './run-subagent.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { AgentStreamChunk } from './wire-types.ts'

function mockProvider(chunks: ProviderStreamChunk[][]): LLMProvider {
  let call = 0
  return {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      for (const chunk of at(chunks, call++ % chunks.length)) yield chunk
    },
  }
}

describe('runSubagent', () => {
  it('cuts a reasoning circle at the product checkpoint and recovers', async () => {
    let streamCalls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalls++
        if (streamCalls === 1) {
          yield {
            type: 'reasoning',
            text: "I'm going in circles and repeating the same plan.".padEnd(8_300, ' '),
          }
          return
        }
        yield { type: 'text', text: 'Recovered summary.' }
        yield { type: 'done' }
      },
    }

    const { summary } = await runSubagent({
      provider,
      prompt: 'Investigate',
      parentGoal: 'Finish the task',
      tools: [],
      parentToolCallId: 'parent-circle',
      onSubagentChunk: () => {},
      executeTool: async () => '',
    })

    assert.equal(streamCalls, 2)
    assert.equal(summary, 'Recovered summary.')
  })

  it('returns summary from final assistant text', async () => {
    const subagentChunks: AgentStreamChunk[] = []
    const { summary, session } = await runSubagent({
      provider: mockProvider([
        [{ type: 'text', text: 'Found auth in src/auth.ts' }, { type: 'done' }],
      ]),
      prompt: 'Find auth code',
      parentGoal: 'Explain authentication',
      tools: [],
      parentToolCallId: 'parent-1',
      onSubagentChunk: (c) => subagentChunks.push(c),
      executeTool: async () => '',
    })

    assert.equal(summary, 'Found auth in src/auth.ts')
    assert.equal(session.status, 'done')
    assert.ok(subagentChunks.some((c) => c.type === 'subagent_start'))
    assert.ok(subagentChunks.some((c) => c.type === 'subagent_done'))
  })

  it('forwards inner tool calls as subagent chunks', async () => {
    const subagentChunks: AgentStreamChunk[] = []
    await runSubagent({
      provider: mockProvider([
        [
          {
            type: 'tool_call',
            toolCall: { id: 'inner-1', name: 'read_file', args: { path: 'a.ts' } },
          },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'Summary of a.ts' }, { type: 'done' }],
      ]),
      prompt: 'Read a.ts',
      parentGoal: 'Review a.ts',
      tools: [{ name: 'read_file', description: '', parameters: {} }],
      parentToolCallId: 'parent-2',
      onSubagentChunk: (c) => subagentChunks.push(c),
      executeTool: async () => 'file contents',
    })

    assert.ok(subagentChunks.some((c) => c.type === 'subagent_tool_call'))
    assert.ok(subagentChunks.some((c) => c.type === 'subagent_tool_result'))
  })

  it('accumulates usage across inner agent steps', async () => {
    let call = 0
    const usages = [
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 50, outputTokens: 5 },
    ]
    const provider = {
      lastUsage: null as { inputTokens: number; outputTokens: number } | null,
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        const u = at(usages, call)
        provider.lastUsage = u
        const chunks =
          call++ === 0
            ? ([
                {
                  type: 'tool_call' as const,
                  toolCall: { id: 'inner-1', name: 'read_file', args: { path: 'a.ts' } },
                },
                { type: 'done' as const },
              ] as const)
            : ([{ type: 'text' as const, text: 'Summary' }, { type: 'done' as const }] as const)
        for (const chunk of chunks) yield chunk
      },
    } satisfies LLMProvider & { lastUsage: { inputTokens: number; outputTokens: number } | null }

    const { session } = await runSubagent({
      provider,
      prompt: 'Read a.ts',
      parentGoal: 'Review',
      tools: [{ name: 'read_file', description: '', parameters: {} }],
      parentToolCallId: 'parent-usage',
      onSubagentChunk: () => {},
      executeTool: async () => 'contents',
      usageModel: 'test-model',
    })

    assert.deepEqual(session.usage, { inputTokens: 150, outputTokens: 15 })
  })

  it('attributes per-stream usage chunks and ignores a stale shared lastUsage (#112)', async () => {
    // Simulate the shared-provider race: lastUsage holds a wrong value (as if the
    // parent stream overwrote it), but each subagent stream carries an
    // authoritative usage chunk. Usage must come from the per-stream chunks.
    let call = 0
    const provider = {
      lastUsage: { inputTokens: 99999, outputTokens: 88888 },
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        const chunks =
          call++ === 0
            ? ([
                {
                  type: 'tool_call' as const,
                  toolCall: { id: 'inner-1', name: 'read_file', args: { path: 'a.ts' } },
                },
                { type: 'usage' as const, model: 'sub', inputTokens: 100, outputTokens: 10 },
                { type: 'done' as const },
              ] as const)
            : ([
                { type: 'text' as const, text: 'Summary' },
                { type: 'usage' as const, model: 'sub', inputTokens: 50, outputTokens: 5 },
                { type: 'done' as const },
              ] as const)
        for (const chunk of chunks) yield chunk
      },
    } satisfies LLMProvider & { lastUsage: { inputTokens: number; outputTokens: number } | null }

    const { session } = await runSubagent({
      provider,
      prompt: 'Read a.ts',
      parentGoal: 'Review',
      tools: [{ name: 'read_file', description: '', parameters: {} }],
      parentToolCallId: 'parent-race',
      onSubagentChunk: () => {},
      executeTool: async () => 'contents',
      usageModel: 'test-model',
    })

    assert.deepEqual(session.usage, { inputTokens: 150, outputTokens: 15 })
  })

  it('records cache tokens and emits subagent usage on subagent_done', async () => {
    const subagentChunks: AgentStreamChunk[] = []
    const provider = {
      lastUsage: null as { inputTokens: number; outputTokens: number } | null,
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        yield { type: 'text' as const, text: 'Summary' }
        yield {
          type: 'usage' as const,
          model: 'sub',
          inputTokens: 1000,
          outputTokens: 20,
          cacheReadTokens: 800,
          cacheCreationTokens: 50,
        }
        yield { type: 'done' as const }
      },
    } satisfies LLMProvider & { lastUsage: { inputTokens: number; outputTokens: number } | null }

    const { session } = await runSubagent({
      provider,
      prompt: 'Read a.ts',
      parentGoal: 'Review',
      tools: [{ name: 'read_file', description: '', parameters: {} }],
      parentToolCallId: 'parent-cache',
      onSubagentChunk: (c) => subagentChunks.push(c),
      executeTool: async () => 'contents',
      usageModel: 'test-model',
    })

    assert.deepEqual(session.usage, {
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheCreationTokens: 50,
    })
    const done = subagentChunks.find((c) => c.type === 'subagent_done')
    assert.ok(done)
    assert.deepEqual(done.usage, {
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheCreationTokens: 50,
    })
  })

  it('honors a custom system prompt, kind, and user task', async () => {
    let received: LLMMessage[] | null = null
    const provider: LLMProvider = {
      async *stream(messages) {
        received = messages
        yield { type: 'text', text: 'CI failed because of a type error in foo.ts:12' }
        yield { type: 'done' }
      },
    }

    const { session } = await runSubagent({
      provider,
      prompt: 'Investigate CI failures for PR #5',
      parentGoal: 'Fix the PR',
      tools: [],
      parentToolCallId: 'parent-ci',
      onSubagentChunk: () => {},
      executeTool: async () => '',
      systemPrompt: CI_INVESTIGATOR_SYSTEM_PROMPT,
      kind: 'investigate_ci',
      userTask: 'Investigate the failing CI checks for pull request #5.',
    })

    assert.equal(session.kind, 'investigate_ci')
    assert.ok(received)
    const messages = received as LLMMessage[]
    const contentOf = (m: LLMMessage | undefined): unknown =>
      m && 'content' in m ? m.content : undefined
    assert.equal(messages[0]?.role, 'system')
    assert.equal(contentOf(messages[0]), CI_INVESTIGATOR_SYSTEM_PROMPT)
    assert.equal(contentOf(messages[1]), 'Investigate the failing CI checks for pull request #5.')
  })

  it('emits a subagent_start chunk carrying the requested kind', async () => {
    const chunks: AgentStreamChunk[] = []
    await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'done' }, { type: 'done' }]]),
      prompt: 'Investigate CI',
      parentGoal: 'Fix',
      tools: [],
      parentToolCallId: 'parent-kind',
      onSubagentChunk: (c) => chunks.push(c),
      executeTool: async () => '',
      kind: 'investigate_ci',
    })
    const start = chunks.find((c) => c.type === 'subagent_start')
    assert.ok(start)
    assert.equal(start.session.kind, 'investigate_ci')
  })

  // --- D1: subagentStart gate + subagentStop notification ---

  it('subagentStart deny prevents the spawn — the loop never runs', async () => {
    let streamCalled = false
    const provider: LLMProvider = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalled = true
        throw new Error('provider must not be called when the spawn is denied')
      },
    }
    const chunks: AgentStreamChunk[] = []
    const { summary, session } = await runSubagent({
      provider,
      prompt: 'Find auth code',
      parentGoal: 'Explain auth',
      tools: [],
      parentToolCallId: 'parent-deny',
      onSubagentChunk: (c) => chunks.push(c),
      executeTool: async () => '',
      kind: 'explore',
      onSubagentStart: () => ({ denied: true, agentMessage: 'blocked by policy' }),
    })

    assert.equal(streamCalled, false)
    assert.equal(session.status, 'error')
    assert.equal(summary, 'blocked by policy')
    // The subagent is surfaced as started-then-failed so the parent gets a result.
    assert.ok(chunks.some((c) => c.type === 'subagent_error'))
    assert.ok(chunks.some((c) => c.type === 'subagent_done'))
  })

  it('subagentStart allow proceeds to the normal run', async () => {
    const { summary, session } = await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'Allowed summary' }, { type: 'done' }]]),
      prompt: 'q',
      parentGoal: 'g',
      tools: [],
      parentToolCallId: 'parent-allow',
      onSubagentChunk: () => {},
      executeTool: async () => '',
      onSubagentStart: () => ({ denied: false }),
    })
    assert.equal(session.status, 'done')
    assert.equal(summary, 'Allowed summary')
  })

  it('fires subagentStop on completion with the subagent type + status', async () => {
    const stops: Array<{ type: string; status: string }> = []
    await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'done' }, { type: 'done' }]]),
      prompt: 'q',
      parentGoal: 'g',
      tools: [],
      parentToolCallId: 'parent-stop',
      onSubagentChunk: () => {},
      executeTool: async () => '',
      kind: 'investigate_ci',
      onSubagentStop: (type, status) => stops.push({ type, status }),
    })
    assert.deepEqual(stops, [{ type: 'investigate_ci', status: 'completed' }])
  })

  it('fires subagentStop with status "error" when the run errors', async () => {
    const stops: Array<{ type: string; status: string }> = []
    const provider: LLMProvider = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        throw new Error('boom')
      },
    }
    const { session } = await runSubagent({
      provider,
      prompt: 'q',
      parentGoal: 'g',
      tools: [],
      parentToolCallId: 'parent-stop-err',
      onSubagentChunk: () => {},
      executeTool: async () => '',
      onSubagentStop: (type, status) => stops.push({ type, status }),
    })
    assert.equal(session.status, 'error')
    assert.deepEqual(stops, [{ type: 'explore', status: 'error' }])
  })

  it('does not fire subagentStop when the spawn was denied (no spawn ⇒ no stop)', async () => {
    let stopFired = false
    await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'x' }, { type: 'done' }]]),
      prompt: 'q',
      parentGoal: 'g',
      tools: [],
      parentToolCallId: 'parent-deny-nostop',
      onSubagentChunk: () => {},
      executeTool: async () => '',
      onSubagentStart: () => ({ denied: true }),
      onSubagentStop: () => {
        stopFired = true
      },
    })
    assert.equal(stopFired, false)
  })

  it('respects AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { summary } = await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      prompt: 'test',
      parentGoal: 'test',
      tools: [],
      parentToolCallId: 'parent-3',
      signal: controller.signal,
      onSubagentChunk: () => {},
      executeTool: async () => '',
    })
    assert.match(summary, /no summary|Exploration completed/)
  })

  it('words the empty-summary fallback for the session kind', async () => {
    const controller = new AbortController()
    controller.abort()
    const { summary } = await runSubagent({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      prompt: 'Add the flag',
      parentGoal: 'test',
      tools: [],
      parentToolCallId: 'parent-4',
      signal: controller.signal,
      onSubagentChunk: () => {},
      executeTool: async () => '',
      kind: 'delegate',
    })
    assert.equal(summary, 'Worker finished with no report.')
  })
})
