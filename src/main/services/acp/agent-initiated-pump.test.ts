import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream, type SessionUpdate } from '@agentclientprotocol/sdk'
import { buildAcpAgentApp, type AcpTurnContext, type AcpTurnRunner } from './acp-agent-server.ts'
import {
  cancelAgentInitiatedTurn,
  endsSelfStartedTurn,
  isAgentWorkUpdate,
  runAcpSessionPrompt,
  type AcpClientHandlers,
} from './acp-client.ts'
import {
  acquireAcpSession,
  cancelAgentInitiatedAcpTurn,
  disposeAllAcpSessions,
} from './acp-session-pool.ts'
import type { AgentInitiatedTurnLease } from './agent-initiated-turn.ts'

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/agent-initiated-pump-test' }

function runnerTransport(runner: AcpTurnRunner): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  return () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = buildAcpAgentApp(runner, { name: 'pump-test-agent' }).connect(
      ndJsonStream(a2c.writable, c2a.readable),
    )
    return Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: (): void => {
        agentConnection.close()
      },
    })
  }
}

function recordingLease(): { lease: AgentInitiatedTurnLease; calls: string[] } {
  const calls: string[] = []
  let active = false
  return {
    calls,
    lease: {
      begin: (): void => {
        active = true
        calls.push('begin')
      },
      touch: (): void => {
        calls.push('touch')
      },
      end: (): void => {
        active = false
        calls.push('end')
      },
      isActive: (): boolean => active,
    },
  }
}

describe('update pump and agent-started turns', () => {
  afterEach(async () => {
    await disposeAllAcpSessions()
  })

  it('begins the lease for agent output that arrives with no prompt outstanding, not during a prompt', async () => {
    let lateContext: AcpTurnContext | undefined
    const runner: AcpTurnRunner = async (ctx) => {
      lateContext = ctx
      await ctx.emit({ type: 'text', text: 'in-turn output' })
      return { stopReason: 'end_turn' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 'pump-thread',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const { lease, calls } = recordingLease()
    entry.open.agentInitiated = lease
    entry.open.handlers.current = {
      onChunk: (): void => {},
      requestPermission: (): ReturnType<AcpClientHandlers['requestPermission']> =>
        Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
    }

    await runAcpSessionPrompt(entry.open, 'go', undefined, undefined)
    assert.deepEqual(calls, [], 'output inside a Copse turn is not an agent-started turn')

    await lateContext?.emit({ type: 'text', text: 'woke up on its own' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(calls, ['begin'])
  })

  it('lets Stop cancel a turn the agent started on its own', async () => {
    let lateContext: AcpTurnContext | undefined
    const runner: AcpTurnRunner = (ctx) => {
      lateContext = ctx
      return Promise.resolve({ stopReason: 'end_turn' })
    }
    const { entry } = await acquireAcpSession({
      threadId: 'stop-thread',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const { lease, calls } = recordingLease()
    entry.open.agentInitiated = lease
    const shown: string[] = []
    entry.open.handlers.current = {
      onChunk: (chunk): void => {
        if (chunk.type === 'text') shown.push(chunk.text)
      },
      requestPermission: (): ReturnType<AcpClientHandlers['requestPermission']> =>
        Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
    }
    const notify = mock.method(entry.open.connection.agent, 'notify')

    await runAcpSessionPrompt(entry.open, 'go', undefined, undefined)
    assert.equal(cancelAgentInitiatedAcpTurn('stop-thread'), false, 'nothing self-started yet')

    await lateContext?.emit({ type: 'text', text: 'woke up on its own' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(cancelAgentInitiatedAcpTurn('stop-thread'), true)
    assert.deepEqual(calls, ['begin', 'end'])
    assert.ok(notify.mock.calls.some((call) => call.arguments[0] === 'session/cancel'))

    await lateContext?.emit({ type: 'text', text: 'trailing output' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(shown, ['woke up on its own'], 'output after Stop stays hidden')
    assert.equal(cancelAgentInitiatedAcpTurn('other-thread'), false)
  })

  it('disposes an agent that keeps a stopped self-started turn going past the grace window', async () => {
    const { entry } = await acquireAcpSession({
      threadId: 'stuck-thread',
      config: CONFIG,
      createTransport: runnerTransport(() => Promise.resolve({ stopReason: 'end_turn' })),
    })
    const { lease } = recordingLease()
    entry.open.agentInitiated = lease
    lease.begin()

    assert.equal(cancelAgentInitiatedTurn(entry.open, 20), true)
    await entry.open.agentInitiatedCancel?.settled
    assert.equal(entry.open.isClosed(), true, 'an agent that never ends the turn is disposed')

    // The next prompt gets a fresh process rather than the one still working.
    const next = await acquireAcpSession({
      threadId: 'stuck-thread',
      config: CONFIG,
      createTransport: runnerTransport(() => Promise.resolve({ stopReason: 'end_turn' })),
    })
    assert.equal(next.fresh, true)
    assert.notEqual(next.entry.open, entry.open)
  })

  it('keeps the session when the agent ends a stopped self-started turn in time', async () => {
    const { entry } = await acquireAcpSession({
      threadId: 'prompt-thread',
      config: CONFIG,
      createTransport: runnerTransport(() => Promise.resolve({ stopReason: 'end_turn' })),
    })
    const { lease } = recordingLease()
    entry.open.agentInitiated = lease
    lease.begin()

    assert.equal(cancelAgentInitiatedTurn(entry.open, 60_000), true)
    // The agent's own end-of-turn marker acknowledges the cancel.
    entry.open.updates.enqueue({
      sessionUpdate: 'usage_update',
      used: 1,
      size: 2,
      _meta: { '_claude/origin': { kind: 'task-notification' } },
    })
    await entry.open.agentInitiatedCancel?.settled
    assert.equal(entry.open.isClosed(), false)
    assert.equal(entry.open.agentInitiatedCancel, undefined)

    const next = await acquireAcpSession({
      threadId: 'prompt-thread',
      config: CONFIG,
      createTransport: runnerTransport(() => Promise.resolve({ stopReason: 'end_turn' })),
    })
    assert.equal(next.fresh, false)
    assert.equal(next.entry.open, entry.open)
  })

  it('classifies work, state replacement and the end-of-turn marker', () => {
    const chunk: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x' },
    }
    const info: SessionUpdate = { sessionUpdate: 'session_info_update', title: 't' }
    const usage = (kind: string | null): SessionUpdate => ({
      sessionUpdate: 'usage_update',
      used: 1,
      size: 2,
      ...(kind ? { _meta: { '_claude/origin': { kind } } } : {}),
    })
    assert.equal(isAgentWorkUpdate(chunk), true)
    assert.equal(isAgentWorkUpdate(info), false)
    assert.equal(isAgentWorkUpdate(usage('task-notification')), false)
    assert.equal(endsSelfStartedTurn(usage('task-notification')), true)
    assert.equal(endsSelfStartedTurn(usage('human')), false, 'a prompt turn is not self-started')
    assert.equal(endsSelfStartedTurn(usage(null)), false)
    assert.equal(endsSelfStartedTurn(chunk), false)
  })
})
