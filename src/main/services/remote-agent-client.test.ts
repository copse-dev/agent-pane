import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import {
  parseSseBlock,
  promptPayloadFromUserContent,
  remoteStreamEventToChunks,
  type RemoteStreamState,
} from '@shared/remote-agent-stream.ts'

function state(): RemoteStreamState {
  return {
    seenToolCalls: new Set(),
    assistantText: '',
    resultText: '',
    terminalStatus: null,
  }
}

describe('remote agent SSE parsing', () => {
  it('parses event, id, and multiline data fields', () => {
    const event = parseSseBlock(
      'id: 1-0\nevent: assistant\ndata: {"text":"hello"}\ndata: {"extra":true}',
    )

    assert.deepEqual(event, {
      id: '1-0',
      event: 'assistant',
      data: '{"text":"hello"}\n{"extra":true}',
    })
  })
})

describe('remoteStreamEventToChunks', () => {
  it('maps assistant deltas to normal text chunks', () => {
    const current = state()
    const chunks = remoteStreamEventToChunks(
      { event: 'assistant', data: JSON.stringify({ text: 'Hello' }) },
      current,
    )

    assert.deepEqual(chunks, [{ type: 'text', text: 'Hello' }])
    assert.equal(current.assistantText, 'Hello')
  })

  it('maps tool call lifecycle updates to existing tool chunks', () => {
    const current = state()
    const running = remoteStreamEventToChunks(
      {
        event: 'tool_call',
        data: JSON.stringify({
          callId: 'call-1',
          name: 'read_file',
          status: 'running',
          args: { path: 'README.md' },
        }),
      },
      current,
    )
    const completed = remoteStreamEventToChunks(
      {
        event: 'tool_call',
        data: JSON.stringify({
          callId: 'call-1',
          name: 'read_file',
          status: 'completed',
          result: { success: { content: '# Project' } },
        }),
      },
      current,
    )

    assert.deepEqual(running, [
      {
        type: 'tool_call',
        toolCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
      },
    ] satisfies StreamChunk[])
    assert.deepEqual(completed, [
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        result: '{\n  "success": {\n    "content": "# Project"\n  }\n}',
        isError: false,
      },
    ] satisfies StreamChunk[])
  })

  it('emits result text only when assistant deltas did not already stream', () => {
    const current = state()
    const chunks = remoteStreamEventToChunks(
      {
        event: 'result',
        data: JSON.stringify({ status: 'FINISHED', text: 'Final answer' }),
      },
      current,
    )

    assert.deepEqual(chunks, [{ type: 'text', text: 'Final answer' }])
    assert.equal(current.assistantText, 'Final answer')
    assert.equal(current.terminalStatus, 'FINISHED')
  })
})

describe('promptPayloadFromUserContent', () => {
  it('converts text and image blocks to Cursor-compatible prompt payloads', () => {
    const payload = promptPayloadFromUserContent([
      { type: 'text', text: 'Inspect this' },
      { type: 'image', dataUrl: 'data:image/png;base64,abc123' },
    ])

    assert.deepEqual(payload, {
      text: 'Inspect this',
      images: [{ mimeType: 'image/png', data: 'abc123' }],
    })
  })
})
