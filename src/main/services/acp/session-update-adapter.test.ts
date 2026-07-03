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

  it('maps reasoning to an agent_thought_chunk', () => {
    const update = streamChunkToSessionUpdate({ type: 'reasoning', text: 'hmm' })
    assert.deepEqual(update, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    })
  })

  it('maps todo_update to a plan, omitting cancelled todos', () => {
    const update = streamChunkToSessionUpdate({
      type: 'todo_update',
      todos: [
        { id: '1', content: 'first', status: 'completed' },
        { id: '2', content: 'skipped', status: 'cancelled' },
        { id: '3', content: 'next', status: 'in_progress' },
      ],
    })
    assert.deepEqual(update, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'first', priority: 'medium', status: 'completed' },
        { content: 'next', priority: 'medium', status: 'in_progress' },
      ],
    })
  })

  it('drops chunks without an ACP equivalent', () => {
    const dropped: StreamChunk[] = [
      { type: 'usage', model: 'm', inputTokens: 1, outputTokens: 2 },
      { type: 'done' },
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

  it('carries the ACP kind so the UI can spot the agent’s shell commands', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'e1',
      title: 'git status',
      kind: 'execute',
      rawInput: {},
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call',
      toolCall: { id: 'e1', name: 'git status', args: {}, kind: 'execute' },
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

  it('maps an agent_thought_chunk to reasoning, not text', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'pondering' },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'reasoning',
      text: 'pondering',
    })
  })

  it('maps a plan to a todo_update with stable index-based ids', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'read the code', priority: 'high', status: 'completed' },
        { content: 'fix the bug', priority: 'medium', status: 'in_progress' },
      ],
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'todo_update',
      todos: [
        { id: 'acp-plan-1', content: 'read the code', status: 'completed' },
        { id: 'acp-plan-2', content: 'fix the bug', status: 'in_progress' },
      ],
    })
  })

  it('drops update kinds the renderer does not consume', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    }
    assert.equal(sessionUpdateToStreamChunk(update), null)
  })
})
