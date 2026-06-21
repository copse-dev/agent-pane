import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSubagent } from './run-subagent.ts'
import type { LLMProvider, StreamChunk } from '@shared/types'

function mockProvider(chunks: StreamChunk[][]): LLMProvider {
  let call = 0
  return {
    async *stream() {
      for (const chunk of chunks[call++ % chunks.length]!) yield chunk
    },
  }
}

describe('runSubagent', () => {
  it('returns summary from final assistant text', async () => {
    const subagentChunks: StreamChunk[] = []
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
    const subagentChunks: StreamChunk[] = []
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
      async *stream() {
        const u = usages[call]!
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
      async *stream() {
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
})
