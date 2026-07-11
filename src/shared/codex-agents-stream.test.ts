import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from './types/index.ts'
import {
  codexAgentEventToChunks,
  createCodexAgentStreamState,
  type CodexAgentStreamState,
} from './codex-agents-stream.ts'

function evt(event: string, data: unknown): { event: string; data: string } {
  return { event, data: JSON.stringify(data) }
}

describe('codexAgentEventToChunks', () => {
  it('maps output_text deltas to text chunks and accumulates them', () => {
    const state = createCodexAgentStreamState()
    const first = codexAgentEventToChunks(evt('response.output_text.delta', { delta: 'Hel' }), state)
    const second = codexAgentEventToChunks(evt('response.output_text.delta', { delta: 'lo' }), state)

    assert.deepEqual(first, [{ type: 'text', text: 'Hel' }])
    assert.deepEqual(second, [{ type: 'text', text: 'lo' }])
    assert.equal(state.assistantText, 'Hello')
  })

  it('surfaces a completed function call and its result once', () => {
    const state = createCodexAgentStreamState()
    const chunks = codexAgentEventToChunks(
      evt('response.output_item.done', {
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_file',
          arguments: { path: 'README.md' },
          output: { content: '# Project' },
        },
      }),
      state,
    )

    assert.deepEqual(chunks, [
      {
        type: 'tool_call',
        toolCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
      },
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        result: '{\n  "content": "# Project"\n}',
        isError: false,
      },
    ] satisfies StreamChunk[])
    assert.equal(state.seenToolCalls.has('call-1'), true)
  })

  it('does not re-emit a tool_call already seen', () => {
    const state: CodexAgentStreamState = createCodexAgentStreamState()
    state.seenToolCalls.add('call-1')
    const chunks = codexAgentEventToChunks(
      evt('response.output_item.added', {
        item: { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: {} },
      }),
      state,
    )
    assert.deepEqual(chunks, [])
  })

  it('emits a whole message item only when no deltas streamed', () => {
    const state = createCodexAgentStreamState()
    const chunks = codexAgentEventToChunks(
      evt('response.output_item.done', {
        item: { type: 'message', content: [{ type: 'output_text', text: 'Final answer' }] },
      }),
      state,
    )
    assert.deepEqual(chunks, [{ type: 'text', text: 'Final answer' }])
    assert.equal(state.assistantText, 'Final answer')
  })

  it('ignores a whole message item when deltas already streamed', () => {
    const state = createCodexAgentStreamState()
    state.assistantText = 'streamed'
    const chunks = codexAgentEventToChunks(
      evt('response.output_item.done', {
        item: { type: 'message', content: [{ type: 'output_text', text: 'streamed' }] },
      }),
      state,
    )
    assert.deepEqual(chunks, [])
  })

  it('marks the stream done on response.completed', () => {
    const state = createCodexAgentStreamState()
    const chunks = codexAgentEventToChunks(
      evt('response.completed', { response: { status: 'completed' } }),
      state,
    )
    assert.deepEqual(chunks, [])
    assert.equal(state.done, true)
    assert.equal(state.terminalStatus, 'completed')
  })

  it('throws on a terminal error event', () => {
    const state = createCodexAgentStreamState()
    assert.throws(
      () => codexAgentEventToChunks(evt('error', { message: 'boom', code: 'rate_limit' }), state),
      /Codex Cloud Agent stream error \(rate_limit\): boom/,
    )
  })

  it('ignores unknown events and invalid JSON', () => {
    const state = createCodexAgentStreamState()
    assert.deepEqual(codexAgentEventToChunks(evt('response.created', {}), state), [])
    assert.deepEqual(codexAgentEventToChunks({ event: 'response.output_text.delta', data: '{' }, state), [])
  })
})
