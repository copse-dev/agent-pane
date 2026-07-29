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

  it('maps a tool_call to a pending tool_call update with its ACP kind', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_call',
      toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
    })
    assert.deepEqual(update, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'a.ts' },
    })
  })

  it('titles a run_shell call with the command and kind execute', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_call',
      toolCall: { id: 't2', name: 'run_shell', args: { command: 'git status' } },
    })
    assert.deepEqual(update, {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'git status',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'git status' },
    })
  })

  it('falls back to the tool name when a shell call has no command', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_call',
      toolCall: { id: 't3', name: 'run_background', args: { action: 'list' } },
    })
    assert.equal(update?.sessionUpdate, 'tool_call')
    assert.equal(update.title, 'run_background')
    assert.equal(update.kind, 'execute')
  })

  it('keeps unmapped tools as kind other', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_call',
      toolCall: { id: 't4', name: 'ask_user', args: {} },
    })
    if (update?.sessionUpdate !== 'tool_call') assert.fail('expected tool_call')
    assert.equal(update.kind, 'other')
  })

  it('maps a successful tool_result to a completed tool_call_update', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_result',
      toolCallId: 't1',
      result: 'contents',
      isError: false,
    })
    assert.equal(update?.sessionUpdate, 'tool_call_update')
    assert.equal(update.status, 'completed')
  })

  it('marks an error tool_result as failed', () => {
    const update = streamChunkToSessionUpdate({
      type: 'tool_result',
      toolCallId: 't1',
      result: 'boom',
      isError: true,
    })
    if (update?.sessionUpdate !== 'tool_call_update') assert.fail('expected tool_call_update')
    assert.equal(update.status, 'failed')
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

  it('maps a copse.todos panel_update to a plan (P4)', () => {
    // The `copse.todos` first-party pack emits `panel_update` with a level-2
    // list panel (`todosToPanelListData`). External ACP clients speak `plan`,
    // so the adapter forwards the pack panel through as a plan update with
    // the same cancelled-omitted policy the `todo_update` path uses.
    const update = streamChunkToSessionUpdate({
      type: 'panel_update',
      packId: 'copse.todos',
      contributionId: 'plan',
      data: {
        kind: 'list',
        title: 'To-dos',
        summary: '1/2 done',
        rows: [
          { id: 't1', label: 'first', status: 'completed' },
          { id: 't2', label: 'skipped', status: 'cancelled' },
          { id: 't3', label: 'next', status: 'in_progress' },
        ],
      },
    })
    assert.deepEqual(update, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'first', priority: 'medium', status: 'completed' },
        { content: 'next', priority: 'medium', status: 'in_progress' },
      ],
    })
  })

  it('drops a panel_update from a pack that has no ACP counterpart', () => {
    // Only the todos plan panel maps to `plan`. A generic pack panel from
    // some future pack (or a wrong contribution id) is silently dropped so
    // external clients never receive a plan update they cannot interpret.
    const notTodos = streamChunkToSessionUpdate({
      type: 'panel_update',
      packId: 'copse.someday',
      contributionId: 'plan',
      data: { kind: 'list', rows: [] },
    })
    assert.equal(notTodos, null)

    const wrongContribution = streamChunkToSessionUpdate({
      type: 'panel_update',
      packId: 'copse.todos',
      contributionId: 'not-plan',
      data: { kind: 'list', rows: [] },
    })
    assert.equal(wrongContribution, null)

    const treePanel = streamChunkToSessionUpdate({
      type: 'panel_update',
      packId: 'copse.todos',
      contributionId: 'plan',
      data: { kind: 'tree', roots: [] },
    })
    assert.equal(treePanel, null)
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

  it('drops the unspecified `other` kind so plain tool calls stay clean', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file',
      kind: 'other',
      rawInput: { path: 'a.ts' },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call',
      toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
    })
  })

  it('preserves arguments and content from an in-progress tool_call_update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      title: '`npm test`',
      status: 'in_progress',
      rawInput: { command: 'npm test', timeout_ms: 30_000 },
      content: [
        { type: 'content', content: { type: 'text', text: 'part1 ' } },
        { type: 'content', content: { type: 'text', text: 'part2' } },
      ],
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call_update',
      toolCallId: 't9',
      name: 'npm test',
      args: { command: 'npm test', timeout_ms: 30_000 },
      status: 'running',
      result: 'part1 part2',
      resultFormat: 'markdown',
    })
  })

  it('preserves structured raw output from a completed tool_call_update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      rawOutput: { exitCode: 0, stdout: 'all good' },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call_update',
      toolCallId: 't9',
      status: 'done',
      result: '{\n  "exitCode": 0,\n  "stdout": "all good"\n}',
      resultFormat: 'markdown',
    })
  })

  it('unwraps text from a successful MCP raw-output envelope', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      rawOutput: {
        result: {
          content: [
            { type: 'text', text: 'first block' },
            { type: 'text', text: 'second block' },
          ],
          structuredContent: null,
          _meta: null,
        },
        error: null,
      },
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call_update',
      toolCallId: 't9',
      status: 'done',
      result: 'first block\nsecond block',
      resultFormat: 'markdown',
    })
  })

  it('prefers unwrapped MCP text when ACP also supplies JSON display content', () => {
    const rawOutput = {
      result: {
        content: [{ type: 'text', text: 'readable result' }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
    }
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: JSON.stringify(rawOutput, null, 2) },
        },
      ],
      rawOutput,
    }
    assert.deepEqual(sessionUpdateToStreamChunk(update), {
      type: 'tool_call_update',
      toolCallId: 't9',
      status: 'done',
      result: 'readable result',
      resultFormat: 'markdown',
    })
  })

  it('preserves an MCP error envelope instead of hiding its details', () => {
    const rawOutput = {
      result: {
        content: [{ type: 'text', text: 'partial output' }],
        structuredContent: null,
      },
      error: { code: -1, message: 'tool failed' },
    }
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'failed',
      rawOutput,
    }
    const chunk = sessionUpdateToStreamChunk(update)
    assert.ok(chunk?.type === 'tool_call_update')
    assert.equal(chunk.result, JSON.stringify(rawOutput, null, 2))
  })

  it('preserves structured and mixed-media MCP results', () => {
    const rawOutputs: unknown[] = [
      {
        result: {
          content: [{ type: 'text', text: 'summary' }],
          structuredContent: { changedFiles: 2 },
        },
        error: null,
      },
      {
        result: {
          content: [
            { type: 'text', text: 'caption' },
            { type: 'image', data: 'encoded-image' },
          ],
          structuredContent: null,
        },
        error: null,
      },
    ]

    for (const rawOutput of rawOutputs) {
      const update: SessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't9',
        status: 'completed',
        rawOutput,
      }
      const chunk = sessionUpdateToStreamChunk(update)
      assert.ok(chunk?.type === 'tool_call_update')
      assert.equal(chunk.result, JSON.stringify(rawOutput, null, 2))
    }
  })

  it('ignores an empty tool_call_update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
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
