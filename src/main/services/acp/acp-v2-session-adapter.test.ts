import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { StreamChunk } from '@shared/types'
import { createV2SessionAdapter } from './acp-v2-session-adapter.ts'
import { nodeReadableStream } from './node-byte-streams.ts'

/**
 * The v2 adapter prototype, driven two ways: synthetic updates for the shapes a
 * real agent does not happen to send, and one end-to-end turn against a
 * repo-owned dual-version fixture built only from public SDK APIs — the same token-free peer
 * `acp-v2-conformance.test.ts` uses.
 */

// `apply` takes a `SessionUpdate`, so these literals are contextually typed
// against the SDK's own union — real values, no cast. (The union does not narrow
// on its discriminant when READ; see the adapter's header.)
const CONTENT = (text: string): v2.ContentBlock => ({ type: 'text', text })

describe('v2 session adapter', () => {
  it('streams message chunks as deltas', () => {
    const adapter = createV2SessionAdapter()
    const first = adapter.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: CONTENT('Hel'),
    })
    const second = adapter.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: CONTENT('lo'),
    })
    assert.deepEqual(first.chunks, [
      {
        type: 'acp_content',
        channel: 'message',
        messageId: 'm1',
        content: { type: 'text', text: 'Hel' },
      },
    ])
    assert.deepEqual(second.chunks, [
      {
        type: 'acp_content',
        channel: 'message',
        messageId: 'm1',
        content: { type: 'text', text: 'lo' },
      },
    ])
  })

  it('maps a whole-message upsert onto an id-scoped replacement', () => {
    const adapter = createV2SessionAdapter()
    adapter.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: CONTENT('draft'),
    })
    const replaced = adapter.apply({
      sessionUpdate: 'agent_message',
      messageId: 'm1',
      content: [CONTENT('final')],
    })
    assert.deepEqual(replaced.chunks, [
      {
        type: 'acp_content_replace',
        channel: 'message',
        messageId: 'm1',
        content: [{ type: 'text', text: 'final' }],
      },
    ])
  })

  it('revises one of several messages without replaying its siblings', () => {
    const adapter = createV2SessionAdapter()
    adapter.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: CONTENT('one '),
    })
    adapter.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: CONTENT('two'),
    })
    const revised = adapter.apply({
      sessionUpdate: 'agent_message',
      messageId: 'm1',
      content: [CONTENT('ONE ')],
    })
    assert.deepEqual(revised.chunks, [
      {
        type: 'acp_content_replace',
        channel: 'message',
        messageId: 'm1',
        content: [{ type: 'text', text: 'ONE ' }],
      },
    ])
  })

  it('matches a spec-literal message fold and stays idempotent on whole-message replay', () => {
    const adapter = createV2SessionAdapter()
    const chunks: StreamChunk[] = []
    const updates: v2.SessionUpdate[] = [
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: CONTENT('draft'),
      },
      {
        sessionUpdate: 'agent_message',
        messageId: 'm1',
        content: [CONTENT('final')],
      },
      {
        sessionUpdate: 'agent_message',
        messageId: 'm1',
        content: [CONTENT('final')],
      },
      {
        sessionUpdate: 'agent_message',
        messageId: 'm2',
        content: [CONTENT('second')],
      },
    ]
    for (const update of updates) {
      chunks.push(...adapter.apply(update).chunks)
    }

    const folded = new Map<string, string>()
    for (const chunk of chunks) {
      if (chunk.type === 'acp_content' && chunk.content.type === 'text' && chunk.messageId) {
        folded.set(chunk.messageId, (folded.get(chunk.messageId) ?? '') + chunk.content.text)
      }
      if (chunk.type === 'acp_content_replace') {
        folded.set(
          chunk.messageId,
          chunk.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
        )
      }
    }

    assert.deepEqual(
      [...folded],
      [
        ['m1', 'final'],
        ['m2', 'second'],
      ],
    )
  })

  it('preserves whole-thought upserts and rich message content', () => {
    const adapter = createV2SessionAdapter()
    assert.deepEqual(
      adapter.apply({
        sessionUpdate: 'agent_thought',
        messageId: 'thought-1',
        content: [CONTENT('revised reasoning')],
      }).chunks,
      [
        {
          type: 'acp_content_replace',
          channel: 'thought',
          messageId: 'thought-1',
          content: [{ type: 'text', text: 'revised reasoning' }],
        },
      ],
    )
    assert.deepEqual(
      adapter.apply({
        sessionUpdate: 'agent_message',
        messageId: 'rich-1',
        content: [
          CONTENT('see '),
          { type: 'image', data: 'pixels', mimeType: 'image/png', uri: 'file:///shot.png' },
        ],
      }).chunks,
      [
        {
          type: 'acp_content_replace',
          channel: 'message',
          messageId: 'rich-1',
          content: [
            { type: 'text', text: 'see ' },
            {
              type: 'image',
              dataUrl: 'data:image/png;base64,pixels',
              mimeType: 'image/png',
              uri: 'file:///shot.png',
            },
          ],
        },
      ],
    )
  })

  it('opens a tool card on the first update for an id and patches after', () => {
    const adapter = createV2SessionAdapter()
    const opened = adapter.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      name: 'read_file',
      rawInput: { path: 'a.ts' },
      status: 'in_progress',
    })
    const patched = adapter.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
    })
    assert.deepEqual(opened.chunks, [
      {
        type: 'tool_call',
        toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      },
      {
        type: 'tool_call_update',
        toolCallId: 't1',
        name: 'read_file',
        programmaticName: 'read_file',
        args: { path: 'a.ts' },
        status: 'running',
      },
    ])
    assert.deepEqual(patched.chunks, [
      { type: 'tool_call_update', toolCallId: 't1', status: 'done' },
    ])
  })

  it('keeps terminal output on an initially completed tool update', () => {
    const adapter = createV2SessionAdapter()
    assert.deepEqual(
      adapter.apply({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-complete',
        name: 'read_file',
        status: 'completed',
        content: [{ type: 'content', content: CONTENT('file contents') }],
      }).chunks,
      [
        {
          type: 'tool_call',
          toolCall: { id: 't-complete', name: 'read_file', args: {} },
        },
        {
          type: 'tool_call_update',
          toolCallId: 't-complete',
          name: 'read_file',
          programmaticName: 'read_file',
          status: 'done',
          result: 'file contents',
          resultFormat: 'markdown',
          images: [],
          content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
        },
      ],
    )
  })

  it('ends the turn on the idle state update, not on a chunk', () => {
    const adapter = createV2SessionAdapter()
    assert.deepEqual(adapter.apply({ sessionUpdate: 'state_update', state: 'running' }), {
      chunks: [],
    })
    const idle = adapter.apply({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'end_turn',
    })
    assert.deepEqual(idle.chunks, [])
    assert.equal(idle.stopReason, 'end_turn')
  })

  it('carries the agent-reported context window through unchanged from v1', () => {
    const adapter = createV2SessionAdapter()
    const applied = adapter.apply({ sessionUpdate: 'usage_update', used: 250, size: 1000 })
    assert.deepEqual(applied.chunks, [
      {
        type: 'context_pressure',
        contextWindow: 1000,
        conversationBudget: 1000,
        conversationTokens: 250,
        fillRatio: 0.25,
        source: 'agent-reported',
      },
    ])
  })

  it('drops the prompt the agent echoes back', () => {
    // `user_message` is our own prompt replayed; the thread already has it.
    const adapter = createV2SessionAdapter()
    assert.deepEqual(
      adapter.apply({
        sessionUpdate: 'user_message',
        messageId: 'u1',
        content: [CONTENT('hello')],
      }),
      { chunks: [] },
    )
  })
})

const EXAMPLE_AGENT = join(process.cwd(), 'tests/fixtures/acp-dual-version-agent.mjs')

function spawnExampleAgent(): ChildProcessWithoutNullStreams {
  assert.ok(existsSync(EXAMPLE_AGENT), `missing SDK example agent at ${EXAMPLE_AGENT}`)
  return spawn(process.execPath, [EXAMPLE_AGENT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('v2 session adapter against the SDK example agent', () => {
  it('turns a real v2 turn into Copse chunks and a stop reason', async () => {
    const child = spawnExampleAgent()
    try {
      const adapter = createV2SessionAdapter()
      const chunks: StreamChunk[] = []
      const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
      const stream = ndJsonStream(writable, nodeReadableStream(child.stdout))

      const stopReason = await v2.client({ name: 'copse' }).connectWith(stream, async (ctx) => {
        await ctx.request(v2.methods.agent.initialize, {
          info: { name: 'copse', version: '0.0.0' },
          protocolVersion: v2.PROTOCOL_VERSION,
          capabilities: {},
        })
        return ctx.buildSession('/tmp/project').withSession(async (session) => {
          session.prompt('hello')
          for (;;) {
            const message = await session.nextUpdate()
            const applied = adapter.apply(message.update)
            chunks.push(...applied.chunks)
            if (message.kind === 'stop') return applied.stopReason
          }
        })
      })

      // The agent's reply arrives as one whole `agent_message`: the id-scoped
      // upsert path is exercised end to end without relying on package internals.
      assert.deepEqual(chunks, [
        {
          type: 'acp_content_replace',
          channel: 'message',
          messageId: 'agent-1',
          content: [{ type: 'text', text: 'Hello from the v2 implementation.' }],
        },
      ])
      assert.equal(stopReason, 'end_turn')
    } finally {
      child.kill()
    }
  })
})
