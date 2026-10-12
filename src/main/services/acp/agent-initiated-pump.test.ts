import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream, type SessionUpdate } from '@agentclientprotocol/sdk'
import { buildAcpAgentApp, type AcpTurnContext, type AcpTurnRunner } from './acp-agent-server.ts'
import {
  endsSelfStartedTurn,
  isAgentWorkUpdate,
  runAcpSessionPrompt,
  type AcpClientHandlers,
} from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'
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
  return {
    calls,
    lease: {
      begin: (): void => {
        calls.push('begin')
      },
      touch: (): void => {
        calls.push('touch')
      },
      end: (): void => {
        calls.push('end')
      },
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
