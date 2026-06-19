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
