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
})
