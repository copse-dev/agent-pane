import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import {
  sessionUpdateToStreamChunks,
  streamChunkToSessionUpdate,
} from './session-update-adapter.ts'

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
    // The `copse.todos` first-party plugin emits `panel_update` with a level-2
    // list panel (`todosToPanelListData`). External ACP clients speak `plan`,
    // so the adapter forwards the plugin panel through as a plan update with
    // the same cancelled-omitted policy the `todo_update` path uses.
    const update = streamChunkToSessionUpdate({
      type: 'panel_update',
      pluginId: 'copse.todos',
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

  it('drops a panel_update from a plugin that has no ACP counterpart', () => {
    // Only the todos plan panel maps to `plan`. A generic plugin panel from
    // some future plugin (or a wrong contribution id) is silently dropped so
    // external clients never receive a plan update they cannot interpret.
    const notTodos = streamChunkToSessionUpdate({
      type: 'panel_update',
      pluginId: 'copse.someday',
      contributionId: 'plan',
      data: { kind: 'list', rows: [] },
    })
    assert.equal(notTodos, null)

    const wrongContribution = streamChunkToSessionUpdate({
      type: 'panel_update',
      pluginId: 'copse.todos',
      contributionId: 'not-plan',
      data: { kind: 'list', rows: [] },
    })
    assert.equal(wrongContribution, null)

    const treePanel = streamChunkToSessionUpdate({
      type: 'panel_update',
      pluginId: 'copse.todos',
      contributionId: 'plan',
      data: { kind: 'tree', roots: [] },
    })
    assert.equal(treePanel, null)
  })
})

describe('sessionUpdateToStreamChunks (client role)', () => {
  for (const status of ['completed', 'failed'] as const) {
    it(`preserves an initial ${status} status even without output`, () => {
      assert.deepEqual(
        sessionUpdateToStreamChunks({
          sessionUpdate: 'tool_call',
          toolCallId: 'finished',
          title: 'read_file',
          status,
        }),
        [
          {
            type: 'tool_call',
            toolCall: { id: 'finished', name: 'read_file', title: 'read_file', args: {} },
          },
          {
            type: 'tool_call_update',
            toolCallId: 'finished',
            status: status === 'failed' ? 'error' : 'done',
          },
        ],
      )
    })
  }

  it('keeps output from an initial running call without marking it complete', () => {
    assert.deepEqual(
      sessionUpdateToStreamChunks({
        sessionUpdate: 'tool_call',
        toolCallId: 'running',
        title: 'Build',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'Compiling…' } }],
      }),
      [
        {
          type: 'tool_call',
          toolCall: { id: 'running', name: 'Build', title: 'Build', args: {} },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'running',
          result: 'Compiling…',
          resultFormat: 'markdown',
          images: [],
          content: [{ type: 'content', content: { type: 'text', text: 'Compiling…' } }],
        },
      ],
    )
  })

  it('uses the same MCP output decoding for a completed announcement and a later update', () => {
    const update = {
      toolCallId: 'completed',
      title: 'Read',
      status: 'completed',
      rawOutput: { result: { content: [{ type: 'text', text: 'file contents' }] } },
    } satisfies Omit<Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>, 'sessionUpdate'>
    const chunks = sessionUpdateToStreamChunks({ ...update, sessionUpdate: 'tool_call' })
    assert.deepEqual(chunks, [
      {
        type: 'tool_call',
        toolCall: { id: 'completed', name: 'Read', title: 'Read', args: {} },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'completed',
        status: 'done',
        result: 'file contents',
        resultFormat: 'markdown',
        images: [],
        content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
      },
    ])
  })

  it('preserves image content from an initially completed tool call', () => {
    assert.deepEqual(
      sessionUpdateToStreamChunks({
        sessionUpdate: 'tool_call',
        toolCallId: 'generated-image',
        title: 'Generate image',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'Created the image.' } },
          {
            type: 'content',
            content: { type: 'image', data: 'base64-payload', mimeType: 'image/webp' },
          },
        ],
      }),
      [
        {
          type: 'tool_call',
          toolCall: {
            id: 'generated-image',
            name: 'Generate image',
            title: 'Generate image',
            args: {},
          },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'generated-image',
          status: 'done',
          result: 'Created the image.',
          resultFormat: 'markdown',
          images: [{ dataUrl: 'data:image/webp;base64,base64-payload', kind: 'screenshot' }],
          content: [
            { type: 'content', content: { type: 'text', text: 'Created the image.' } },
            {
              type: 'content',
              content: {
                type: 'image',
                dataUrl: 'data:image/webp;base64,base64-payload',
                mimeType: 'image/webp',
              },
            },
          ],
        },
      ],
    )
  })

  it('maps an agent_message_chunk with its message boundary', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-1',
      content: { type: 'text', text: 'hello' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'acp_content',
        channel: 'message',
        messageId: 'message-1',
        content: { type: 'text', text: 'hello' },
      },
    ])
  })

  it('maps a tool_call to a tool_call chunk', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      title: 'search',
      rawInput: { q: 'x' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: { id: 't9', name: 'search', title: 'search', args: { q: 'x' } },
      },
    ])
  })

  it('keeps a meaningful ACP title distinct from the programmatic tool name', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't-title',
      title: 'Read the project manifest',
      name: 'copse.read_file',
      rawInput: { path: 'package.json' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: {
          id: 't-title',
          name: 'copse.read_file',
          title: 'Read the project manifest',
          programmaticName: 'copse.read_file',
          args: { path: 'package.json' },
        },
      },
    ])
  })

  it('uses the programmatic name for Cursor’s generic MCP title', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't-mcp',
      title: 'MCP: tool',
      name: 'mcp__copse__read_archive',
      rawInput: { path: 'thread.zip' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: {
          id: 't-mcp',
          name: 'mcp__copse__read_archive',
          title: 'MCP: tool',
          programmaticName: 'mcp__copse__read_archive',
          args: { path: 'thread.zip' },
        },
      },
    ])
  })

  it('keeps Cursor’s generic MCP title when no programmatic name is available', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't-generic',
      title: 'MCP: tool',
      rawInput: {},
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: { id: 't-generic', name: 'MCP: tool', title: 'MCP: tool', args: {} },
      },
    ])
  })

  it('accepts a programmatic name supplied by a later tool update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-late-name',
      name: 'copse.search_code',
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't-late-name',
        name: 'copse.search_code',
        programmaticName: 'copse.search_code',
      },
    ])
  })

  it('preserves a title-only tool update', () => {
    assert.deepEqual(
      sessionUpdateToStreamChunks({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'renamed',
        title: 'Read the generated report',
      }),
      [
        {
          type: 'tool_call_update',
          toolCallId: 'renamed',
          title: 'Read the generated report',
        },
      ],
    )
  })

  it('carries the ACP kind so the UI can spot the agent’s shell commands', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'e1',
      title: 'git status',
      kind: 'execute',
      rawInput: {},
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: {
          id: 'e1',
          name: 'git status',
          title: 'git status',
          args: {},
          kind: 'execute',
        },
      },
    ])
  })

  it('drops the unspecified `other` kind so plain tool calls stay clean', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file',
      kind: 'other',
      rawInput: { path: 'a.ts' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call',
        toolCall: {
          id: 't1',
          name: 'read_file',
          title: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ])
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
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't9',
        title: 'npm test',
        args: { command: 'npm test', timeout_ms: 30_000 },
        status: 'running',
        result: 'part1 part2',
        resultFormat: 'markdown',
        images: [],
        content: [
          { type: 'content', content: { type: 'text', text: 'part1 ' } },
          { type: 'content', content: { type: 'text', text: 'part2' } },
        ],
      },
    ])
  })

  it('emits complete replacement patches for mixed, text-only, image-only, and empty content', () => {
    const replace = (
      content: Exclude<
        Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>['content'],
        undefined
      >,
    ): StreamChunk | undefined =>
      sessionUpdateToStreamChunks({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'replace-me',
        content,
      })[0]

    const mixed = replace([
      { type: 'content', content: { type: 'text', text: 'caption' } },
      {
        type: 'content',
        content: { type: 'image', data: 'mixed-image', mimeType: 'image/png' },
      },
    ])
    assert.deepEqual(mixed, {
      type: 'tool_call_update',
      toolCallId: 'replace-me',
      result: 'caption',
      resultFormat: 'markdown',
      images: [{ dataUrl: 'data:image/png;base64,mixed-image', kind: 'screenshot' }],
      content: [
        { type: 'content', content: { type: 'text', text: 'caption' } },
        {
          type: 'content',
          content: {
            type: 'image',
            dataUrl: 'data:image/png;base64,mixed-image',
            mimeType: 'image/png',
          },
        },
      ],
    })
    assert.deepEqual(replace([{ type: 'content', content: { type: 'text', text: 'new text' } }]), {
      type: 'tool_call_update',
      toolCallId: 'replace-me',
      result: 'new text',
      resultFormat: 'markdown',
      images: [],
      content: [{ type: 'content', content: { type: 'text', text: 'new text' } }],
    })
    assert.deepEqual(
      replace([
        {
          type: 'content',
          content: { type: 'image', data: 'new-image', mimeType: 'image/webp' },
        },
      ]),
      {
        type: 'tool_call_update',
        toolCallId: 'replace-me',
        result: null,
        images: [{ dataUrl: 'data:image/webp;base64,new-image', kind: 'screenshot' }],
        content: [
          {
            type: 'content',
            content: {
              type: 'image',
              dataUrl: 'data:image/webp;base64,new-image',
              mimeType: 'image/webp',
            },
          },
        ],
      },
    )
    assert.deepEqual(replace([]), {
      type: 'tool_call_update',
      toolCallId: 'replace-me',
      result: null,
      images: [],
      content: [],
    })
  })

  it('normalizes every ACP tool content variant and replacement metadata', () => {
    const [chunk] = sessionUpdateToStreamChunks({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'rich',
      title: 'Inspect outputs',
      name: 'inspect_outputs',
      kind: 'search',
      locations: [{ path: 'src/a.ts', line: 12 }],
      content: [
        {
          type: 'content',
          content: { type: 'audio', data: 'audio-bytes', mimeType: 'audio/ogg' },
        },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'https://example.test/report',
            name: 'report',
            title: 'Report',
            description: 'Generated report',
            mimeType: 'text/html',
            size: 42,
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'notes' },
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///archive.bin',
              mimeType: 'application/octet-stream',
              blob: 'binary-bytes',
            },
          },
        },
        { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 'terminal-1' },
      ],
    })
    assert.ok(chunk?.type === 'tool_call_update')
    assert.equal(chunk.title, 'Inspect outputs')
    assert.equal(chunk.name, 'inspect_outputs')
    assert.equal(chunk.programmaticName, 'inspect_outputs')
    assert.equal(chunk.kind, 'search')
    assert.deepEqual(chunk.locations, [{ path: 'src/a.ts', line: 12 }])
    assert.equal(chunk.result, null)
    assert.deepEqual(chunk.images, [])
    assert.ok(chunk.content)
    assert.equal(chunk.content.length, 6)
    assert.deepEqual(chunk.content[0], {
      type: 'content',
      content: {
        type: 'audio',
        dataUrl: 'data:audio/ogg;base64,audio-bytes',
        mimeType: 'audio/ogg',
      },
    })
    assert.deepEqual(chunk.content.at(-2), {
      type: 'diff',
      path: 'src/a.ts',
      oldText: 'old',
      newText: 'new',
    })
    assert.deepEqual(chunk.content.at(-1), { type: 'terminal', terminalId: 'terminal-1' })
  })

  it('preserves structured raw output from a completed tool_call_update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      rawOutput: { exitCode: 0, stdout: 'all good' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't9',
        status: 'done',
        result: '{\n  "exitCode": 0,\n  "stdout": "all good"\n}',
        resultFormat: 'markdown',
      },
    ])
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
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't9',
        status: 'done',
        result: 'first block\nsecond block',
        resultFormat: 'markdown',
        images: [],
        content: [
          { type: 'content', content: { type: 'text', text: 'first block' } },
          { type: 'content', content: { type: 'text', text: 'second block' } },
        ],
      },
    ])
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
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't9',
        status: 'done',
        result: 'readable result',
        resultFormat: 'markdown',
        images: [],
        content: [{ type: 'content', content: { type: 'text', text: 'readable result' } }],
      },
    ])
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
    const [chunk] = sessionUpdateToStreamChunks(update)
    assert.ok(chunk?.type === 'tool_call_update')
    assert.equal(chunk.result, JSON.stringify(rawOutput, null, 2))
  })

  it('preserves structured MCP results instead of hiding their details', () => {
    const rawOutput = {
      result: {
        content: [{ type: 'text', text: 'summary' }],
        structuredContent: { changedFiles: 2 },
      },
      error: null,
    }
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      rawOutput,
    }
    const [chunk] = sessionUpdateToStreamChunks(update)
    assert.ok(chunk?.type === 'tool_call_update')
    assert.equal(chunk.result, JSON.stringify(rawOutput, null, 2))
  })

  it('extracts images from a mixed-media MCP raw-output envelope', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'completed',
      rawOutput: {
        result: {
          content: [
            { type: 'text', text: 'caption' },
            { type: 'image', data: 'encoded-image', mimeType: 'image/png' },
          ],
          structuredContent: null,
        },
        error: null,
      },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 't9',
        status: 'done',
        result: 'caption',
        resultFormat: 'markdown',
        images: [{ dataUrl: 'data:image/png;base64,encoded-image', kind: 'screenshot' }],
        content: [
          { type: 'content', content: { type: 'text', text: 'caption' } },
          {
            type: 'content',
            content: {
              type: 'image',
              dataUrl: 'data:image/png;base64,encoded-image',
              mimeType: 'image/png',
            },
          },
        ],
      },
    ])
  })

  it('keeps an image-only MCP result out of Markdown', () => {
    const rawOutput = {
      result: {
        content: [{ type: 'image', data: 'encoded-image', mimeType: 'image/png' }],
        structuredContent: null,
      },
      error: null,
    }
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'generated-image',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: JSON.stringify(rawOutput) },
        },
      ],
      rawOutput,
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'tool_call_update',
        toolCallId: 'generated-image',
        status: 'done',
        result: null,
        images: [{ dataUrl: 'data:image/png;base64,encoded-image', kind: 'screenshot' }],
        content: [
          {
            type: 'content',
            content: {
              type: 'image',
              dataUrl: 'data:image/png;base64,encoded-image',
              mimeType: 'image/png',
            },
          },
        ],
      },
    ])
  })

  it('ignores an empty tool_call_update', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [])
  })

  it('maps an agent_thought_chunk with its thought boundary', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'thought-1',
      content: { type: 'text', text: 'pondering' },
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'acp_content',
        channel: 'thought',
        messageId: 'thought-1',
        content: { type: 'text', text: 'pondering' },
      },
    ])
  })

  it('maps a plan to a todo_update with stable index-based ids', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'read the code', priority: 'high', status: 'completed' },
        { content: 'fix the bug', priority: 'medium', status: 'in_progress' },
      ],
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'todo_update',
        todos: [
          {
            id: 'acp-plan-1',
            content: 'read the code',
            status: 'completed',
            priority: 'high',
          },
          {
            id: 'acp-plan-2',
            content: 'fix the bug',
            status: 'in_progress',
            priority: 'medium',
          },
        ],
      },
    ])
  })

  it('maps usage_update to authoritative live context pressure', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'usage_update',
      used: 80_000,
      size: 200_000,
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'context_pressure',
        contextWindow: 200_000,
        conversationBudget: 200_000,
        conversationTokens: 80_000,
        fillRatio: 0.4,
        source: 'agent-reported',
      },
    ])
  })

  it('preserves ACP usage cost amount and currency', () => {
    const [chunk] = sessionUpdateToStreamChunks({
      sessionUpdate: 'usage_update',
      used: 10,
      size: 100,
      cost: { amount: 0.25, currency: 'USD' },
    })
    assert.ok(chunk?.type === 'context_pressure')
    assert.deepEqual(chunk.cost, { amount: 0.25, currency: 'USD' })
  })

  it('handles a zero-sized usage_update without producing an invalid ratio', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'usage_update',
      used: 0,
      size: 0,
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [
      {
        type: 'context_pressure',
        contextWindow: 0,
        conversationBudget: 0,
        conversationTokens: 0,
        fillRatio: 0,
        source: 'agent-reported',
      },
    ])
  })

  it('drops update kinds the renderer does not consume', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    }
    assert.deepEqual(sessionUpdateToStreamChunks(update), [])
  })
})
