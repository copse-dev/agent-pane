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
      executeTool: async (_name, _args, _signal, _toolCallId) => '',
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
      executeTool: async (_name, _args, _signal, _toolCallId) => '',
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
      executeTool: async (_name, _args, _signal, _toolCallId) => {
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
      executeTool: async (_name, _args, _signal, _toolCallId) => {
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
      executeTool: async (_name, _args, _signal, _toolCallId) => 'ok',
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
      executeTool: async (_name, _args, _signal, _toolCallId) => {
        executeCount++
        return 'listing'
      },
    })
    assert.equal(executeCount, 1)
  })

  it('recovers embedded Cursor-style text tool calls', async () => {
    let executedName = ''
    const embedded = `Checking lint.

<tool_call>
<function=run_shell>
<parameter=command>npm run lint</parameter>
</function>
</tool_call>`
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'text', text: embedded }, { type: 'done' }],
        [{ type: 'text', text: 'All good.' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'lint' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (name, _args, _signal) => {
        executedName = name
        return 'lint ok'
      },
    })
    assert.equal(executedName, 'run_shell')
    assert.ok(chunks.some((c) => c.type === 'text_replace'))
    assert.ok(chunks.some((c) => c.type === 'tool_result'))
  })

  it('surfaces a terminal message when finalize returns empty', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'done' }], [{ type: 'done' }]]),
      messages: [{ role: 'user', content: 'review the repo' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => '',
    })
    assert.ok(
      chunks.some(
        (c) => c.type === 'text' && c.text.includes('stopped before producing a final answer'),
      ),
    )
  })

  it('surfaces refusal when provider reports stopReason refusal', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'done', stopReason: 'refusal' }]]),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => '',
    })
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('declined')))
  })

  it('continues after max_tokens truncation with partial text', async () => {
    let calls = 0
    const provider: LLMProvider = {
      async *stream() {
        calls++
        if (calls === 1) {
          yield { type: 'text', text: 'partial ' }
          yield { type: 'done', stopReason: 'max_tokens' }
        } else {
          yield { type: 'text', text: 'answer' }
          yield { type: 'done', stopReason: 'end_turn' }
        }
      },
    }
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => '',
    })
    assert.equal(calls, 2)
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('answer')))
  })
})
