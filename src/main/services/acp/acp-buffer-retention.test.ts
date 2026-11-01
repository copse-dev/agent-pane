import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { openAcpSession, type AcpTransportFactory } from './acp-client.ts'
import { AcpStartupBuffer } from './acp-startup-buffer.ts'

describe('ACP startup buffering', () => {
  it('discards unmatched live notifications while preserving valid order and bounded heap', async (t) => {
    const enqueue = t.mock.method(AcpStartupBuffer.prototype, 'enqueue')
    const received: string[] = []
    const transport: AcpTransportFactory = () => {
      const c2a = new TransformStream<Uint8Array, Uint8Array>()
      const a2c = new TransformStream<Uint8Array, Uint8Array>()
      const connection = agent({ name: 'unmatched-flood' })
        .onRequest('initialize', () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {},
        }))
        .onRequest('session/new', () => ({ sessionId: 'active' }))
        .onRequest('session/prompt', async (ctx) => {
          for (let index = 0; index < 512; index++) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: 'unmatched-' + String(index),
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: String(index) + 'x'.repeat(64 * 1024) },
              },
            })
          }
          for (const text of ['first', 'second']) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: 'active',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            })
          }
          return { stopReason: 'end_turn' }
        })
        .connect(ndJsonStream(a2c.writable, c2a.readable))
      return Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: () => {
          connection.close()
        },
      })
    }
    const open = await openAcpSession(
      { command: 'unused', cwd: '/acp-buffer-test' },
      {
        current: {
          onChunk: (chunk) => {
            if (chunk.type === 'text') received.push(chunk.text)
          },
          requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
        },
      },
      transport,
    )
    const gc = globalThis.gc
    const heap: number[] = []
    try {
      await new Promise((resolve) => setImmediate(resolve))
      gc?.()
      heap.push(process.memoryUsage().heapUsed)
      for (let round = 0; round < 3; round++) {
        await open.connection.agent.request(methods.agent.session.prompt, {
          sessionId: 'active',
          prompt: [{ type: 'text', text: 'flood' }],
        })
        await new Promise((resolve) => setImmediate(resolve))
        gc?.()
        heap.push(process.memoryUsage().heapUsed)
      }
      assert.equal(enqueue.mock.callCount(), 0, 'active connections never retain unmatched updates')
      assert.deepEqual(received, ['first', 'second', 'first', 'second', 'first', 'second'])
      t.diagnostic(
        JSON.stringify({ gcEnabled: Boolean(gc), heapUsedBytes: heap, unmatchedPayloadMiB: 96 }),
      )
      if (gc) {
        assert.ok(
          Math.max(...heap) - Math.min(...heap) < 16 * 1024 * 1024,
          'retained heap stays below 16 MiB across a 96 MiB flood',
        )
      }
    } finally {
      await open.dispose()
    }
  })

  it('rejects an excessive pre-response notification burst and releases the transport', async () => {
    let disposed = false
    const transport: AcpTransportFactory = () => {
      const c2a = new TransformStream<Uint8Array, Uint8Array>()
      const a2c = new TransformStream<Uint8Array, Uint8Array>()
      const connection = agent({ name: 'startup-flood' })
        .onRequest('initialize', () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {},
        }))
        .onRequest('session/new', async (ctx) => {
          for (let index = 0; index < 4097; index++) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: 'opening',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: String(index) },
              },
            })
          }
          return { sessionId: 'opening' }
        })
        .connect(ndJsonStream(a2c.writable, c2a.readable))
      return Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: () => {
          disposed = true
          connection.close()
        },
      })
    }

    await assert.rejects(async () => {
      const open = await openAcpSession(
        { command: 'unused', cwd: '/acp-buffer-test' },
        { current: null },
        transport,
      )
      await open.dispose()
    }, /ACP.*buffer.*limit/i)
    assert.equal(disposed, true)
  })
})
