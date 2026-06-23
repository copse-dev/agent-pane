import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from './run-agent-loop.ts'
import { getLastMeasuredInputTokens, setLastMeasuredInputTokens } from './trim-history.ts'
import type { LLMMessage, LLMProvider, StreamChunk } from '@shared/types'

function mockProvider(chunks: StreamChunk[][]): LLMProvider {
  let call = 0
  return {
    async *stream() {
      for (const chunk of chunks[call++ % chunks.length]!) yield chunk
    },
  }
}

/** Assert the Anthropic invariant: every assistant tool_use has a tool_result. */
function assertToolPairingValid(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    const next = messages[i + 1]
    assert.equal(
      next?.role,
      'tool',
      `assistant tool_use at ${i} must be followed by a tool message`,
    )
    const have = new Set(next?.role === 'tool' ? next.toolResults.map((r) => r.toolCallId) : [])
    for (const tc of m.content) {
      assert.ok(have.has(tc.id), `tool_use ${tc.id} has no matching tool_result`)
    }
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

  it('does not execute tools with unparseable args; returns an error result (#114)', async () => {
    let executed = false
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [
          {
            type: 'tool_call',
            toolCall: { id: '1', name: 'write_file', args: {}, argsError: 'bad JSON' },
          },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'recovered' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => {
        executed = true
        return 'result'
      },
    })
    assert.equal(executed, false, 'tool must not run with malformed args')
    const errorResult = chunks.find((c) => c.type === 'tool_result')
    assert.ok(errorResult)
    assert.equal(errorResult.type === 'tool_result' && errorResult.isError, true)
    assert.match(errorResult.type === 'tool_result' ? errorResult.result : '', /bad JSON/)
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

  it('leaves API-valid history (no orphan tool_use) after mid-batch abort', async () => {
    const controller = new AbortController()
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: '1', name: 'a', args: {} } },
          { type: 'tool_call', toolCall: { id: '2', name: 'b', args: {} } },
          { type: 'done' },
        ],
      ]),
      messages,
      tools: [],
      onChunk: () => {},
      signal: controller.signal,
      executeTool: async (_name, _args, _signal, id) => {
        if (id === '1') {
          controller.abort()
          return 'ok'
        }
        return 'never'
      },
    })
    assertToolPairingValid(messages)
  })

  it('leaves API-valid history when aborted during the provider stream', async () => {
    const controller = new AbortController()
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    const provider: LLMProvider = {
      async *stream() {
        yield { type: 'tool_call', toolCall: { id: '1', name: 'a', args: {} } }
        controller.abort()
        yield { type: 'done' }
      },
    }
    await runAgentLoop({
      provider,
      messages,
      tools: [],
      onChunk: () => {},
      signal: controller.signal,
      executeTool: async () => 'unused',
    })
    assertToolPairingValid(messages)
  })

  it('leaves API-valid history when the LLM call budget is exhausted mid-loop', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'loop', args: {} } }, { type: 'done' }],
      ]),
      messages,
      tools: [],
      maxSteps: 10,
      maxLlmCalls: 2,
      onChunk: () => {},
      executeTool: async () => 'ok',
    })
    assertToolPairingValid(messages)
  })

  it('stops on the wall-clock deadline even when steps remain', async () => {
    let calls = 0
    const provider: LLMProvider = {
      async *stream() {
        calls++
        yield { type: 'tool_call', toolCall: { id: String(calls), name: 'loop', args: {} } }
        yield { type: 'done' }
      },
    }
    const chunks: StreamChunk[] = []
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    await runAgentLoop({
      provider,
      messages,
      tools: [],
      maxSteps: 100,
      maxLlmCalls: 100,
      runTimeoutMs: 0, // deadline already passed -> first budget check trips
      onChunk: (c) => chunks.push(c),
      executeTool: async () => 'ok',
    })
    assert.equal(calls, 0)
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('time or LLM call limit')))
    assert.equal(chunks.at(-1)?.type, 'done')
    assertToolPairingValid(messages)
  })

  it('prefers per-stream usage chunks over the shared lastUsage field (#112)', async () => {
    const provider = {
      lastUsage: { inputTokens: 99999, outputTokens: 88888 },
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text', text: 'answer' }
        yield { type: 'usage', model: 'real-model', inputTokens: 321, outputTokens: 12 }
        yield { type: 'done' }
      },
    }
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      usageModel: 'attributed-model',
      getLastUsage: () => provider.lastUsage,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
    })
    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.inputTokens, 321)
    assert.equal(usage.outputTokens, 12)
    assert.equal(usage.model, 'attributed-model')
  })

  it('falls back to getLastUsage when the stream emits no usage chunk', async () => {
    const provider = {
      lastUsage: { inputTokens: 120, outputTokens: 80 },
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text', text: 'answer' }
        yield { type: 'done' }
      },
    }
    const chunks: StreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      usageModel: 'attributed-model',
      getLastUsage: () => provider.lastUsage,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
    })
    const usage = chunks.find((c) => c.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.inputTokens, 120)
    assert.equal(usage.outputTokens, 80)
  })

  it('restores measured input tokens after a tool runs a nested loop (#112)', async () => {
    // A tool (e.g. an explore subagent or local todo worker) can run a nested
    // agent loop that overwrites the shared `lastMeasuredInputTokens` global with
    // its own stream sizes. The parent loop must restore its own measurement so
    // the next turn's trim/escalation sizing is not skewed by the subagent.
    let measuredAtSecondStream: number | null = -1
    let call = 0
    const provider: LLMProvider = {
      async *stream() {
        if (call++ === 0) {
          yield { type: 'tool_call', toolCall: { id: '1', name: 'test', args: {} } }
          yield { type: 'usage', model: 'm', inputTokens: 1000, outputTokens: 10 }
          yield { type: 'done' }
        } else {
          // Sampled after the top-of-loop sizing for the second turn ran.
          measuredAtSecondStream = getLastMeasuredInputTokens()
          yield { type: 'text', text: 'final' }
          yield { type: 'usage', model: 'm', inputTokens: 2000, outputTokens: 10 }
          yield { type: 'done' }
        }
      },
    }
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxContextTokens: 100_000,
      usageModel: 'm',
      onChunk: () => {},
      executeTool: async () => {
        // Simulate a nested loop clobbering the shared global.
        setLastMeasuredInputTokens(5)
        return 'tool done'
      },
    })
    assert.equal(measuredAtSecondStream, 1000)
  })
})
