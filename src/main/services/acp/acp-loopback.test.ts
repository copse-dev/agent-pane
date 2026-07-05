import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'

/**
 * End-to-end check that Copse's ACP **agent** and **client** halves interoperate
 * over real ndjson framing. The two ends are wired through a pair of in-memory
 * byte pipes — no subprocess, no network — so the full request/notification
 * round trip (initialize → prompt → updates → permission → stop) is exercised.
 */
describe('ACP agent <-> client loopback', () => {
  it('streams text, a tool call, a permission round-trip, and a tool result', async () => {
    // Two byte pipes: client->agent and agent->client.
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)

    const runner: AcpTurnRunner = async (ctx) => {
      await ctx.emit({ type: 'text', text: `echo:${ctx.prompt}` })
      await ctx.emit({
        type: 'tool_call',
        toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      })
      const decision = await ctx.requestPermission({
        toolCallId: 't1',
        title: 'read_file',
        rawInput: { path: 'a.ts' },
      })
      await ctx.emit({
        type: 'tool_result',
        toolCallId: 't1',
        result: decision === 'allow' ? 'file contents' : 'denied',
        isError: decision !== 'allow',
      })
      return { stopReason: 'end_turn' }
    }

    // Agent side: serve until the connection closes.
    buildAcpAgentApp(runner, { name: 'copse-test' }).connect(agentStream)

    const chunks: StreamChunk[] = []
    let permissionAsked = false

    // Client side: drive a single prompt and collect the translated chunks.
    const result = await client({ name: 'test-client' })
      .onRequest(methods.client.session.requestPermission, () => {
        permissionAsked = true
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      })
      .connectWith(clientStream, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        return ctx.buildSession('/tmp/project').withSession(async (session) => {
          session.prompt('hello')
          for (;;) {
            const message = await session.nextUpdate()
            if (message.kind === 'stop') return message.response
            const chunk = sessionUpdateToStreamChunk(message.update)
            if (chunk) chunks.push(chunk)
          }
        })
      })

    assert.equal(result.stopReason, 'end_turn')
    assert.ok(permissionAsked, 'agent should have requested permission from the client')

    const text = chunks.find((c) => c.type === 'text')
    assert.deepEqual(text, { type: 'text', text: 'echo:hello' })

    const toolCall = chunks.find((c) => c.type === 'tool_call')
    assert.deepEqual(toolCall, {
      type: 'tool_call',
      toolCall: { id: 't1', name: 'read_file', args: { path: 'a.ts' } },
    })

    const toolResult = chunks.find((c) => c.type === 'tool_result')
    assert.deepEqual(toolResult, {
      type: 'tool_result',
      toolCallId: 't1',
      result: 'file contents',
      isError: false,
      // ACP tool output is agent-authored Markdown, so the client-side adapter
      // tags it for the Markdown render path.
      resultFormat: 'markdown',
    })
  })
})
