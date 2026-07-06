import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from './internal-utils.ts'
import { runAgentLoop } from './run-agent-loop.ts'
import { AGENT_RUN_ABORT_REASON_TIMEOUT, AgentRunDeadline } from './agent-loop-limits.ts'
import { getLastMeasuredInputTokens, setLastMeasuredInputTokens } from './trim-history.ts'
import {
  REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  REASONING_RUNAWAY_GIVEUP_MESSAGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '@copse/llm/provider-stop-reason.ts'
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

/** Assert the Anthropic invariant: every assistant tool_use has a tool_result. */
function assertToolPairingValid(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    const next = messages[i + 1]
    assert.ok(
      next?.role === 'tool',
      `assistant tool_use at ${String(i)} must be followed by a tool message`,
    )
    const have = new Set(next.toolResults.map((r) => r.toolCallId))
    for (const tc of m.content) {
      assert.ok(have.has(tc.id), `tool_use ${tc.id} has no matching tool_result`)
    }
  }
}

describe('runAgentLoop', () => {
  it('emits done after text-only response', async () => {
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    assert.equal(errorResult.isError, true)
    assert.match(errorResult.result, /bad JSON/)
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
    const chunks: AgentStreamChunk[] = []
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

  it('cuts off a runaway single generation and recovers with a short answer (#489)', async () => {
    // A local model that ignores output caps streams an unbounded answer. The
    // first turn floods text well past the per-stream output cap (>32k tokens ≈
    // >128k chars) and never emits `done`; the loop must abort that turn instead
    // of consuming forever, then accept the next turn's concise answer.
    const flood: ProviderStreamChunk[] = []
    for (let i = 0; i < 200; i++) flood.push({ type: 'text', text: 'x'.repeat(1000) })
    let streamCalls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalls++
        if (streamCalls === 1) {
          for (const c of flood) yield c
          return // no `done`: the guard, not the provider, ends this turn
        }
        yield { type: 'text', text: 'Short final answer.' }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxSteps: 5,
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => 'ok',
    })
    assert.ok(streamCalls >= 2, 'loop must continue past the runaway turn')
    assert.ok(
      chunks.some((c) => c.type === 'text' && c.text.includes('Short final answer.')),
      'recovers with the next turn answer',
    )
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('forces an answer instead of re-priming after a reasoning-only runaway (#489)', async () => {
    // A model loops in its "thinking": the first stream floods reasoning past the
    // per-stream cap with no answer and no tool call. Reasoning never lands in
    // history, so "continue from where you left off" would just restart the loop.
    // The loop must instead push a force-answer nudge and accept the next answer.
    const flood: ProviderStreamChunk[] = []
    for (let i = 0; i < 200; i++) flood.push({ type: 'reasoning', text: 'x'.repeat(1000) })
    let streamCalls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalls++
        if (streamCalls === 1) {
          for (const c of flood) yield c
          return // no `done`: the cap, not the provider, ends this turn
        }
        yield { type: 'text', text: 'Final answer.' }
        yield { type: 'done' }
      },
    }
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages,
      tools: [],
      maxSteps: 5,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => 'ok',
    })
    assert.ok(streamCalls >= 2, 'loop must continue past the reasoning runaway')
    assert.ok(
      chunks.some((c) => c.type === 'text' && c.text.includes('Final answer.')),
      'recovers with the next turn answer',
    )
    const userTexts = messages.flatMap((m) =>
      m.role === 'user' && typeof m.content === 'string' ? [m.content] : [],
    )
    assert.ok(
      userTexts.includes(REASONING_RUNAWAY_FORCE_ANSWER_NUDGE),
      'pushes the force-answer nudge',
    )
    assert.ok(
      !userTexts.includes(TRUNCATION_CONTINUE_NUDGE),
      'does not push the continue nudge that re-primes the loop',
    )
  })

  it('gives up cleanly when reasoning keeps tripping the cap (#489)', async () => {
    // The model ignores the force-answer nudge and loops in reasoning again. Rather
    // than re-prime until the wall-clock deadline, the run ends after the second
    // reasoning runaway with a surfaced explanation.
    const flood: ProviderStreamChunk[] = []
    for (let i = 0; i < 200; i++) flood.push({ type: 'reasoning', text: 'x'.repeat(1000) })
    let streamCalls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        streamCalls++
        for (const c of flood) yield c // every stream loops, never emits `done`
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      maxSteps: 20,
      onChunk: (c) => chunks.push(c),
      executeTool: async () => 'ok',
    })
    assert.equal(streamCalls, 2, 'ends after one force-answer retry, not the call budget')
    assert.ok(
      chunks.some((c) => c.type === 'text' && c.text === REASONING_RUNAWAY_GIVEUP_MESSAGE),
      'surfaces the give-up message',
    )
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
    const chunks: AgentStreamChunk[] = []
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

  /** Exact XML from Review-Icon export line 19 — tools never fired before recovery fix. */
  const PHANTOM_READ_FILE_XML = `<tool_call>
<function=read_file>
<parameter=path>
src/renderer/views/titlebar.ts
</parameter>
</function>
</tool_call>
<tool_call>
<function=read_file>
<parameter=path>
src/renderer/views/projects-pane.ts
</parameter>
</function>
</tool_call>`

  it('recovers phantom read_file XML from finalize text-only turn', async () => {
    const readPaths: string[] = []
    let textOnlyCalls = 0
    const provider: LLMProvider = {
      async *stream(_messages, tools) {
        if (tools.length === 0) {
          textOnlyCalls++
          yield {
            type: 'text',
            text: textOnlyCalls === 1 ? PHANTOM_READ_FILE_XML : 'Icons look good.',
          }
          yield { type: 'done' }
          return
        }
        yield { type: 'tool_call', toolCall: { id: '1', name: 'list_dir', args: { path: '.' } } }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'verify settings icons' }],
      tools: [{ name: 'list_dir', description: '', parameters: {} }],
      maxSteps: 1,
      onChunk: (c) => chunks.push(c),
      coerceTextToolCallArgs: (name, args) => {
        if (name === 'read_file' && typeof args['path'] === 'string' && args['path'].trim()) {
          return args
        }
        return null
      },
      executeTool: async (name, args) => {
        if (name === 'read_file') readPaths.push((args as { path: string }).path)
        return 'file contents'
      },
    })
    assert.deepEqual(readPaths, [
      'src/renderer/views/titlebar.ts',
      'src/renderer/views/projects-pane.ts',
    ])
    assert.ok(chunks.some((c) => c.type === 'text_replace'))
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('Icons look good')))
  })

  it('recovers phantom read_file XML from forced text-only turn', async () => {
    const readPaths: string[] = []
    let listDirCalls = 0
    let textOnlyStreams = 0
    const provider: LLMProvider = {
      async *stream(_messages, tools) {
        if (tools.length === 0) {
          textOnlyStreams++
          yield { type: 'text', text: PHANTOM_READ_FILE_XML }
          yield { type: 'done' }
          return
        }
        listDirCalls++
        yield {
          type: 'tool_call',
          toolCall: { id: `ld-${String(listDirCalls)}`, name: 'list_dir', args: { path: '.' } },
        }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'verify settings icons' }],
      tools: [{ name: 'list_dir', description: '', parameters: {} }],
      maxContextTokens: 8192,
      maxSteps: 20,
      onChunk: (c) => chunks.push(c),
      coerceTextToolCallArgs: (name, args) => {
        if (name === 'read_file' && typeof args['path'] === 'string' && args['path'].trim()) {
          return args
        }
        return null
      },
      executeTool: async (name, args) => {
        if (name === 'read_file') readPaths.push((args as { path: string }).path)
        return 'file contents'
      },
    })
    assert.ok(textOnlyStreams >= 1, 'expected at least one forced text-only provider call')
    assert.ok(listDirCalls >= 6, 'expected enough tool steps to trigger forced text answer')
    assert.deepEqual(readPaths, [
      'src/renderer/views/titlebar.ts',
      'src/renderer/views/projects-pane.ts',
    ])
    assert.ok(chunks.some((c) => c.type === 'tool_result'))
  })

  it('stops when max LLM call budget is exhausted', async () => {
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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
    const chunks: AgentStreamChunk[] = []
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

  it('surfaces the run limit message when aborted for timeout', async () => {
    const controller = new AbortController()
    controller.abort(AGENT_RUN_ABORT_REASON_TIMEOUT)
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
      signal: controller.signal,
    })
    assert.ok(chunks.some((c) => c.type === 'text' && c.text.includes('time or LLM call limit')))
    assert.equal(chunks.at(-1)?.type, 'done')
  })

  it('stays silent on a user-initiated abort (non-timeout reason)', async () => {
    const controller = new AbortController()
    controller.abort('user-stop')
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]]),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => '',
      signal: controller.signal,
    })
    assert.ok(
      !chunks.some((c) => c.type === 'text' && c.text.includes('time or LLM call limit')),
      'a user abort must not surface the run-limit message',
    )
    assert.equal(chunks.length, 1) // only 'done'
  })

  it('keeps the idle clock paused while a tool executes', async () => {
    // The deadline is only polled at loop tops, and activity is recorded right
    // after each tool batch — so pausing is what protects an in-flight tool from
    // the idle timeout (it stops the external abort scheduler firing mid-tool).
    // Assert the wiring directly: the clock must be paused at the instant the tool
    // runs, and pause/resume must stay balanced. No real time needed.
    const deadline = new AgentRunDeadline(150, 60_000)
    const events: string[] = []
    const origPause = deadline.pause.bind(deadline)
    const origResume = deadline.resume.bind(deadline)
    deadline.pause = (now): void => {
      events.push('pause')
      origPause(now)
    }
    deadline.resume = (now): void => {
      events.push('resume')
      origResume(now)
    }
    let pausedDuringTool: boolean | null = null
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider: mockProvider([
        [{ type: 'tool_call', toolCall: { id: '1', name: 'slow', args: {} } }, { type: 'done' }],
        [{ type: 'text', text: 'finished' }, { type: 'done' }],
      ]),
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      runDeadline: deadline,
      executeTool: async () => {
        pausedDuringTool = events.lastIndexOf('pause') > events.lastIndexOf('resume')
        return 'ok'
      },
    })
    assert.equal(pausedDuringTool, true, 'idle clock must be paused while a tool executes')
    const pauses = events.filter((e) => e === 'pause').length
    const resumes = events.filter((e) => e === 'resume').length
    assert.equal(pauses, resumes, 'every pause must be matched by a resume')
    assert.ok(chunks.some((c) => c.type === 'text' && c.text === 'finished'))
  })

  it('prefers per-stream usage chunks over the shared lastUsage field (#112)', async () => {
    const provider = {
      lastUsage: { inputTokens: 99999, outputTokens: 88888 },
      async *stream(): AsyncIterable<ProviderStreamChunk> {
        yield { type: 'text', text: 'answer' }
        yield { type: 'usage', model: 'real-model', inputTokens: 321, outputTokens: 12 }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
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
    assert.ok(usage)
    assert.equal(usage.inputTokens, 321)
    assert.equal(usage.outputTokens, 12)
    assert.equal(usage.model, 'attributed-model')
  })

  it('falls back to getLastUsage when the stream emits no usage chunk', async () => {
    const provider = {
      lastUsage: { inputTokens: 120, outputTokens: 80 },
      async *stream(): AsyncIterable<ProviderStreamChunk> {
        yield { type: 'text', text: 'answer' }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
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
    assert.ok(usage)
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

describe('parallel explore fan-out', () => {
  function instrumentedExecuteTool(delaysMs: Record<string, number>): {
    executeTool: (
      name: string,
      args: unknown,
      signal: AbortSignal,
      toolCallId: string,
    ) => Promise<string>
    maxInFlight: () => number
  } {
    let inFlight = 0
    let max = 0
    return {
      executeTool: async (_name, _args, _signal, toolCallId): Promise<string> => {
        inFlight++
        max = Math.max(max, inFlight)
        await new Promise((resolve) => setTimeout(resolve, delaysMs[toolCallId] ?? 1))
        inFlight--
        return `${toolCallId}-summary`
      },
      maxInFlight: (): number => max,
    }
  }

  it('runs a fanned-out batch of explore calls concurrently, results in call order', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    // e1 finishes last, e3 first — result order must still follow call order.
    const tools = instrumentedExecuteTool({ e1: 30, e2: 20, e3: 10 })
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: 'e1', name: 'explore', args: { query: 'a' } } },
          { type: 'tool_call', toolCall: { id: 'e2', name: 'explore', args: { query: 'b' } } },
          { type: 'tool_call', toolCall: { id: 'e3', name: 'explore', args: { query: 'c' } } },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'done' }, { type: 'done' }],
      ]),
      messages,
      tools: [],
      onChunk: () => {},
      executeTool: tools.executeTool,
    })
    assert.ok(
      tools.maxInFlight() >= 2,
      `explore calls must overlap (max in flight: ${String(tools.maxInFlight())})`,
    )
    const toolMsg = messages.find((m) => m.role === 'tool')
    assert.ok(toolMsg?.role === 'tool')
    assert.deepEqual(
      toolMsg.toolResults.map((r) => r.toolCallId),
      ['e1', 'e2', 'e3'],
    )
    assert.deepEqual(
      toolMsg.toolResults.map((r) => r.result),
      ['e1-summary', 'e2-summary', 'e3-summary'],
    )
    assertToolPairingValid(messages)
  })

  it('keeps explores serial when they follow another tool in the batch', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    const tools = instrumentedExecuteTool({ r1: 10, e1: 5, e2: 5 })
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: 'r1', name: 'run_shell', args: {} } },
          { type: 'tool_call', toolCall: { id: 'e1', name: 'explore', args: { query: 'a' } } },
          { type: 'tool_call', toolCall: { id: 'e2', name: 'explore', args: { query: 'b' } } },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'done' }, { type: 'done' }],
      ]),
      messages,
      tools: [],
      onChunk: () => {},
      executeTool: tools.executeTool,
    })
    assert.equal(
      tools.maxInFlight(),
      1,
      'explores after a mutating tool must observe its effects — no overlap',
    )
    assertToolPairingValid(messages)
  })

  it('propagates a pre-started explore failure through the normal error path', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'go' }]
    const results: { toolCallId: string; isError: boolean }[] = []
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: 'tool_call', toolCall: { id: 'e1', name: 'explore', args: { query: 'a' } } },
          { type: 'tool_call', toolCall: { id: 'e2', name: 'explore', args: { query: 'b' } } },
          { type: 'done' },
        ],
        [{ type: 'text', text: 'done' }, { type: 'done' }],
      ]),
      messages,
      tools: [],
      onChunk: (c) => {
        if (c.type === 'tool_result') results.push({ toolCallId: c.toolCallId, isError: c.isError })
      },
      executeTool: async (_name, _args, _signal, toolCallId) => {
        // The failing call rejects immediately, before the loop awaits it —
        // the settled wrapper must hold it without an unhandled rejection.
        if (toolCallId === 'e1') throw new Error('explore blew up')
        await new Promise((resolve) => setTimeout(resolve, 10))
        return 'ok'
      },
    })
    assert.deepEqual(results, [
      { toolCallId: 'e1', isError: true },
      { toolCallId: 'e2', isError: false },
    ])
    assertToolPairingValid(messages)
  })
})
