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

  it('stops when max LLM call budget is exhausted', async () => {
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'loop', args: {} } }, { type: 'done' }],
        [{ type: 'text', text: 'never reached' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxSteps: 10,
      maxLlmCalls: 1,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => 'ok',
    })
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('LLM call limit')))
    assert.equal(chunks.at(-1)?.type, 'done')
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

  it('adds cancelled tool results when aborted mid-batch', async () => {
    const controller = new AbortController()
    const messages = [{ role: 'user', content: 'go' }] as const
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: '1', name: 'a', args: {} } },
          { type: 'tool_call', toolCall: { id: '2', name: 'b', args: {} } },
          { type: 'done' },
        ],
      ]),
      messages: [...messages],
      tools: [],
      onChunk: (c) => chunks.push(c),
      signal: controller.signal,
      executeTool: async (_name, _args, _signal, id) => {
        if (id === '1') {
          controller.abort()
          return 'ok'
        }
        return 'never'
      },
    })
    const cancelled = chunks.filter(
      (c) => c.type === 'tool_result' && c.result.includes('cancelled'),
    )
    assert.equal(cancelled.length, 1)
  })

  it('nudges to close open todos before finalize', async () => {
    const chunks: StreamChunk[] = []
    let nudgeText = ''
    const provider: LLMProvider = {
      async *stream(messages) {
        const last = messages.at(-1)
        if (
          last &&
          'content' in last &&
          typeof last.content === 'string' &&
          last.content.includes('open todos')
        ) {
          nudgeText = last.content
          yield { type: 'text', text: 'All todos done.' }
        }
        yield { type: 'done' }
      },
    }
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'big task' }],
      tools: [],
      maxSteps: 1,
      getOpenTodos: () => [{ id: '1', content: 'Pending step', status: 'pending' }],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
    })
    assert.match(nudgeText, /open todos/)
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('All todos done')))
  })
})
