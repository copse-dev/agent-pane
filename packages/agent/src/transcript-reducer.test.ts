import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptReducer } from './transcript-reducer.ts'
import type { SubagentMessage } from './wire-types.ts'

function message(id: string): SubagentMessage {
  return { id, role: 'assistant', content: '', toolCalls: [] }
}

describe('transcript reducer', () => {
  it('updates a tool in its original message after newer prose has arrived', () => {
    const reducer = new TranscriptReducer()
    const first = message('first'),
      second = message('second')
    reducer.reduce({ type: 'reasoning', text: 'Thinking' }, () => first)
    reducer.reduce(
      { type: 'tool_call', toolCall: { id: 'tool', name: 'run_shell', args: {} } },
      () => first,
    )
    reducer.reduce({ type: 'text', text: 'Next step' }, () => second)
    const owner = reducer.reduce(
      {
        type: 'tool_call_update',
        toolCallId: 'tool',
        name: 'Read file',
        args: { path: 'a' },
        result: 'streamed',
        status: 'done',
      },
      () => second,
    )
    assert.equal(owner, first)
    assert.equal(first.reasoning, 'Thinking')
    assert.deepEqual(first.toolCalls[0], {
      id: 'tool',
      name: 'Read file',
      args: { path: 'a' },
      status: 'done',
      result: 'streamed',
    })
    assert.equal(second.content, 'Next step')
    assert.deepEqual(second.toolCalls, [])
  })
  it('leaves grouping to its caller and finalizes only unfinished calls', () => {
    const reducer = new TranscriptReducer(),
      first = message('first')
    for (const id of ['done', 'pending'])
      reducer.reduce(
        { type: 'tool_call', toolCall: { id, name: 'read_file', args: {} } },
        () => first,
      )
    reducer.reduce(
      {
        type: 'tool_result',
        toolCallId: 'done',
        result: 'read',
        isError: false,
        editStats: { additions: 1, deletions: 0 },
      },
      () => {
        throw new Error('results must not create messages')
      },
    )
    reducer.finishPending('interrupted')
    assert.equal(first.toolCalls[0]?.status, 'done')
    assert.equal(first.toolCalls[0].result, 'read')
    assert.deepEqual(first.toolCalls[0].editStats, { additions: 1, deletions: 0 })
    assert.equal(first.toolCalls[1]?.status, 'error')
    assert.equal(first.toolCalls[1].result, 'interrupted')
  })
  it('ignores unrelated events and unknown tool IDs without opening a message', () => {
    const reducer = new TranscriptReducer()
    const ensure = (): never => {
      throw new Error('must not open')
    }
    assert.equal(
      reducer.reduce(
        { type: 'tool_result', toolCallId: 'missing', result: '', isError: false },
        ensure,
      ),
      null,
    )
    assert.equal(
      reducer.reduce({ type: 'usage', model: 'test', inputTokens: 1, outputTokens: 2 }, ensure),
      null,
    )
  })
})
