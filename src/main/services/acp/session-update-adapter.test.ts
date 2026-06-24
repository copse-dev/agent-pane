import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { sessionUpdateToStreamChunk, streamChunkToSessionUpdate } from './session-update-adapter.ts'

describe('streamChunkToSessionUpdate (agent role)', () => {
  it('maps text to an agent_message_chunk', () => {
    const update = streamChunkToSessionUpdate({ type: 'text', text: 'hi' })
    assert.deepEqual(update, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    })
  })

  it('maps text_replace to an agent_message_chunk', () => {
    const update = streamChunkToSessionUpdate({ type: 'text_replace', text: 'redo' })
    assert.equal(update?.sessionUpdate, 'agent_message_chunk')
  })

  it('maps a tool_call to a pending tool_call update', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_call',
      toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
    })
    assert.deepEqual(update, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file',
      kind: 'other',
      status: 'pending',
      rawInput: { path: 'a.ts' },
    })
  })

  it('maps a successful tool_result to a completed tool_call_update', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_result',
      toolCallId: 't1',
      result: 'contents',
      isError: false,
    })
    assert.equal(update?.sessionUpdate, 'tool_call_update')
    assert.equal((update as { status: string }).status, 'completed')
  })

  it('marks an error tool_result as failed', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_result',
      toolCallId: 't1',
      result: 'boom',
      isError: true,
    })
    assert.equal((update as { status: string }).status, 'failed')
  })

  it('drops chunks without an ACP equivalent', () => {
    const dropped: StreamChunk[] = [
      { type: 'usage', model: 'm', inputTokens: 1, outputTokens: 2 },
      { type: 'done' },
      { type: 'todo_update', todos: [] },
    ]
    for (const chunk of dropped) assert.equal(streamChunkToSessionUpdate(chunk), null)
  })
})

describe('sessionUpdateToStreamChunk (client role)', () => {
  it('maps an agent_message_chunk to text', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), { type: 'text', text: 'hello' })
  })

  it('maps a tool_call to a tool_call chunk', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      title: 'search',
      rawInput: { q: 'x' },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call',
      toolCall: { id: 't9', name: 'search', args: { q: 'x' } },
    })
  })

  it('maps a completed tool_call_update to a tool_result and joins text content', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'part1 ' } },
        { type: 'content', content: { type: 'text', text: 'part2' } },
      ],
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_result',
      toolCallId: 't9',
      result: 'part1 part2',
      isError: false,
    })
  })

  it('ignores non-terminal tool_call_update statuses', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'in_progress',
    }
    assert.equal(sessionUpdateToStreamChunk(update), null)
  })

  it('drops update kinds the renderer does not consume', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [],
    }
    assert.equal(sessionUpdateToStreamChunk(update), null)
  })
})
