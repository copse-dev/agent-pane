import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from './run-agent-loop.ts'
import type { LLMProvider, StreamChunk } from '@shared/types'

function mockProvider(chunks: StreamChunk[][]): LLMProvider {
  let call = 0
  return {
    async *stream() {
      for (const chunk of chunks[call++ % chunks.length]!) yield chunk
    },
  }
}

describe('runAgentLoop', () => {
  it('emits done after text-only response', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
    })
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('respects AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
      signal: controller.signal,
    })
    assert.equal(chunks.length, 1) // only 'done'
  })

  it('executes tools and adds tool_result chunks', async () => {
    let executed = false
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'test', args: {} } }, { type: 'done' }],
        [{ type: 'text', text: 'done' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => {
        executed = true
        return 'result'
      },
    })
    assert.ok(executed)
    assert.ok(chunks.some((c) => c.type === 'tool_result'))
  })

  it('stops after maxSteps', async () => {
    let steps = 0
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'loop', args: {} } }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxSteps: 3,
      onChunk: () => {},
      executeTool: async () => {
        steps++
        return 'ok'
      },
    })
    assert.ok(steps <= 3)
  })

  it('emits a final text answer after maxSteps tool-only loop', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'loop', args: {} } }, { type: 'done' }],
        [{ type: 'tool_call', toolCall: { id: '2', name: 'loop', args: {} } }, { type: 'done' }],
        [{ type: 'text', text: 'Here is the repo review.' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'review the repo' }],
      tools: [],
      maxSteps: 2,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => 'ok',
    })
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('repo review')))
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('skips duplicate explore tool execution', async () => {
    let executeCount = 0
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: '1', name: 'list_dir', args: { path: '.' } } },
          { type: 'done' },
        ],
        [
          { type: 'tool_call', toolCall: { id: '2', name: 'list_dir', args: { path: '.' } } },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'Done.' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'review' }],
      tools: [],
      onChunk: () => {},
      executeTool: async () => {
        executeCount++
        return 'listing'
      },
    })
    assert.equal(executeCount, 1)
  })

  it('surfaces a terminal message when finalize returns empty', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'done' }], [{ type: 'done' }]]),
      messages: [{ role: 'user', content: 'review the repo' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
    })
    assert.ok(
      chunks.some(
        (c) => c.type === 'text' && c.text.includes('stopped before producing a final answer'),
      ),
    )
  })
})
