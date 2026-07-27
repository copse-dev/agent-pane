import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
} from '@agentclientprotocol/sdk'
import {
  defaultBlockingReadPrompt,
  defaultLongRunPrompt,
  probeAgentLongRun,
  type AcpLongRunProbeConfig,
  type AcpLongRunProbeOptions,
} from './acp-long-run-probe.ts'

type TransportFactory = NonNullable<AcpLongRunProbeOptions['createTransport']>

function fakeEarlyStopTransport(): TransportFactory {
  return (_config: AcpLongRunProbeConfig) => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)

    agent({ name: 'fake-long-run-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest('session/new', () => ({ sessionId: 'sess-long-1' }))
      .onRequest('session/prompt', async (ctx) => {
        const sessionId = ctx.params.sessionId
        const promptText = promptToText(ctx.params.prompt)
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `ack:${promptText.slice(0, 24)}` },
          },
        })
        return { stopReason: 'end_turn' }
      })
      .onNotification('session/cancel', () => {})
      .connect(agentStream)

    return Promise.resolve({ stream: clientStream, dispose: () => {} })
  }
}

function fakeBlockingReadTransport(): TransportFactory {
  return (_config: AcpLongRunProbeConfig) => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)

    agent({ name: 'fake-blocking-read-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest('session/new', () => ({ sessionId: 'sess-long-2' }))
      .onRequest('session/prompt', async (ctx) => {
        const sessionId = ctx.params.sessionId
        await ctx.client.request(methods.client.fs.readTextFile, {
          sessionId,
          path: '.copse-acp-long-run-block.txt',
        })
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'LONG_RUN_DONE' },
          },
        })
        return { stopReason: 'end_turn' }
      })
      .onNotification('session/cancel', () => {})
      .connect(agentStream)

    return Promise.resolve({ stream: clientStream, dispose: () => {} })
  }
}

function promptToText(prompt: PromptRequest['prompt']): string {
  return prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

const CONFIG: AcpLongRunProbeConfig = {
  agentId: 'fake',
  title: 'Fake Agent',
  command: 'fake-long-run-agent',
  args: [],
  cwd: '/tmp/project',
}

describe('probeAgentLongRun (in-memory agent)', () => {
  it('treats a clean stop before the expected duration as a failed liveness probe', async () => {
    const report = await probeAgentLongRun(CONFIG, {
      createTransport: fakeEarlyStopTransport(),
      durationMs: 60_000,
      progressIntervalMs: 1_000,
      timeoutMs: 5_000,
    })

    assert.equal(report.ok, false)
    assert.equal(report.completedEarly, true)
    assert.equal(report.stopReason, 'end_turn')
    assert.match(report.error ?? '', /completed before expected duration/)
    assert.equal(report.updateCount, 1)
    assert.equal(report.textChunkCount, 1)
    assert.equal(report.prompt, defaultLongRunPrompt(60_000, 1_000))
    assert.equal(report.mode, 'stream')
  })

  it('can hold the turn open with a delayed ACP fs/read_text_file request', async () => {
    const report = await probeAgentLongRun(CONFIG, {
      createTransport: fakeBlockingReadTransport(),
      mode: 'blocking-fs-read',
      durationMs: 10,
      progressIntervalMs: 1_000,
      timeoutMs: 2_000,
    })

    assert.equal(report.ok, true)
    assert.equal(report.completedEarly, false)
    assert.equal(report.stopReason, 'end_turn')
    assert.equal(report.updateCount, 1)
    assert.equal(report.textChunkCount, 1)
    assert.equal(report.prompt, defaultBlockingReadPrompt(10))
    assert.equal(report.mode, 'blocking-fs-read')
  })
})
