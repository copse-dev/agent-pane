import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { openAcpSession, runAcpSessionPrompt } from './acp-client.ts'

describe('ACP tool calls with initial results (#2494)', () => {
  it('delivers a one-event Codex MCP startup failure before the first prompt', async () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const message =
      '[codex-acp forwarded startup error] MCP server `docs` failed to start: connection refused'
    const connection = agent({ name: 'codex-startup-fixture' })
      .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest('session/new', async (ctx) => {
        // codex-acp 1.10.0 createMcpStartupToolCallUpdate emits this single
        // failed tool_call. It never follows it with a tool_call_update.
        await ctx.client.notify(methods.client.session.update, {
          sessionId: 'startup-session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'mcp-startup-docs',
            kind: 'other',
            title: 'mcp__docs__startup',
            status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: message } }],
          },
        })
        return { sessionId: 'startup-session' }
      })
      .onRequest('session/prompt', () => ({ stopReason: 'end_turn' }))
      .connect(ndJsonStream(a2c.writable, c2a.readable))
    const chunks: StreamChunk[] = []
    const open = await openAcpSession(
      { command: 'unused', cwd: '/tmp/acp-startup-fixture' },
      {
        current: {
          onChunk: (chunk) => chunks.push(chunk),
          requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
        },
      },
      () =>
        Promise.resolve({
          stream: ndJsonStream(c2a.writable, a2c.readable),
          dispose: () => {
            connection.close()
          },
        }),
    )
    try {
      await runAcpSessionPrompt(open, 'hello', undefined)
      assert.deepEqual(chunks, [
        {
          type: 'tool_call',
          toolCall: {
            id: 'mcp-startup-docs',
            name: 'mcp__docs__startup',
            title: 'mcp__docs__startup',
            args: {},
          },
        },
        {
          type: 'tool_call_update',
          toolCallId: 'mcp-startup-docs',
          status: 'error',
          result: message,
          resultFormat: 'markdown',
          images: [],
          content: [{ type: 'content', content: { type: 'text', text: message } }],
        },
      ])
    } finally {
      open.dispose()
    }
  })
})
