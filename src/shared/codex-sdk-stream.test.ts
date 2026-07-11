import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from './types/index.ts'
import { codexSdkEventToChunks, createCodexSdkStreamState } from './codex-sdk-stream.ts'

describe('codexSdkEventToChunks', () => {
  it('captures the thread id from thread.started', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks({ type: 'thread.started', thread_id: 't_1' }, state)
    assert.deepEqual(chunks, [])
    assert.equal(state.threadId, 't_1')
  })

  it('maps an agent_message item to text and accumulates it', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Hello' } },
      state,
    )
    assert.deepEqual(chunks, [{ type: 'text', text: 'Hello' }])
    assert.equal(state.assistantText, 'Hello')
  })

  it('maps reasoning to a reasoning chunk', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking' } },
      state,
    )
    assert.deepEqual(chunks, [{ type: 'reasoning', text: 'thinking' }])
    assert.equal(state.assistantText, '')
  })

  it('maps a failed command_execution to a tool call + error result', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'boom',
          exit_code: 1,
          status: 'completed',
        },
      },
      state,
    )
    assert.deepEqual(chunks, [
      { type: 'tool_call', toolCall: { id: 'c1', name: 'shell', args: { command: 'npm test' } } },
      { type: 'tool_result', toolCallId: 'c1', result: 'boom\n[exit 1]', isError: true },
    ] satisfies StreamChunk[])
  })

  it('maps a file_change to an apply_patch tool call + summary result', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      {
        type: 'item.completed',
        item: {
          id: 'f1',
          type: 'file_change',
          changes: [
            { path: 'src/a.ts', kind: 'update' },
            { path: 'src/b.ts', kind: 'add' },
          ],
          status: 'completed',
        },
      },
      state,
    )
    assert.deepEqual(chunks, [
      {
        type: 'tool_call',
        toolCall: {
          id: 'f1',
          name: 'apply_patch',
          args: {
            changes: [
              { path: 'src/a.ts', kind: 'update' },
              { path: 'src/b.ts', kind: 'add' },
            ],
          },
        },
      },
      {
        type: 'tool_result',
        toolCallId: 'f1',
        result: 'update src/a.ts\nadd src/b.ts',
        isError: false,
      },
    ] satisfies StreamChunk[])
  })

  it('maps an mcp_tool_call error to an error result', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      {
        type: 'item.completed',
        item: {
          id: 'm1',
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'create_pr',
          arguments: { title: 'x' },
          error: { message: 'nope' },
          status: 'failed',
        },
      },
      state,
    )
    assert.deepEqual(chunks, [
      {
        type: 'tool_call',
        toolCall: { id: 'm1', name: 'github/create_pr', args: { title: 'x' } },
      },
      { type: 'tool_result', toolCallId: 'm1', result: 'nope', isError: true },
    ] satisfies StreamChunk[])
  })

  it('records usage and marks done on turn.completed', () => {
    const state = createCodexSdkStreamState()
    const chunks = codexSdkEventToChunks(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      },
      state,
    )
    assert.deepEqual(chunks, [])
    assert.equal(state.done, true)
    assert.ok(state.usage)
    assert.equal(state.usage.input_tokens, 10)
    assert.equal(state.usage.output_tokens, 20)
  })

  it('throws on turn.failed and on a fatal error event', () => {
    const s1 = createCodexSdkStreamState()
    assert.throws(
      () => codexSdkEventToChunks({ type: 'turn.failed', error: { message: 'nope' } }, s1),
      /Codex turn failed: nope/,
    )
    const s2 = createCodexSdkStreamState()
    assert.throws(
      () => codexSdkEventToChunks({ type: 'error', message: 'kaboom' }, s2),
      /Codex stream error: kaboom/,
    )
  })

  it('ignores in-progress and unknown events', () => {
    const state = createCodexSdkStreamState()
    assert.deepEqual(codexSdkEventToChunks({ type: 'turn.started' }, state), [])
    assert.deepEqual(
      codexSdkEventToChunks(
        { type: 'item.started', item: { id: 'x', type: 'command_execution' } },
        state,
      ),
      [],
    )
    assert.deepEqual(
      codexSdkEventToChunks(
        { type: 'item.completed', item: { id: 't', type: 'todo_list' } },
        state,
      ),
      [],
    )
  })
})
