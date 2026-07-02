import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import {
  acquireAcpSession,
  acpSessionPoolSize,
  disposeAcpSession,
  disposeAllAcpSessions,
  reapIdleAcpSessions,
} from './acp-session-pool.ts'

/**
 * Persistent per-thread ACP sessions (issue #605), tested against Copse's own
 * in-process ACP agent over real ndjson framing — the same loopback pattern as
 * acp-loopback.test.ts, injected through the pool's transport seam. What the
 * old spawn-per-turn flow could never do — a second turn arriving on the SAME
 * agent session — is exactly what these tests assert.
 */

interface AgentLog {
  spawns: number
  promptSessions: string[]
}

function makeTransportFactory(log: AgentLog): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  const runner: AcpTurnRunner = async (ctx) => {
    log.promptSessions.push(ctx.sessionId)
    await ctx.emit({ type: 'text', text: `echo:${ctx.prompt}` })
    return { stopReason: 'end_turn' }
  }
  return () => {
    log.spawns++
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = buildAcpAgentApp(runner, { name: 'pool-test-agent' }).connect(
      ndJsonStream(a2c.writable, c2a.readable),
    )
    return Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: () => {
        agentConnection.close()
      },
    })
  }
}

function sink(into: StreamChunk[]): AcpClientHandlers {
  return {
    onChunk: (chunk) => into.push(chunk),
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
  }
}

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/pool-test' }

describe('acp-session-pool', () => {
  afterEach(() => {
    disposeAllAcpSessions()
  })

  it('reuses one agent process and one session across turns', async () => {
    const log: AgentLog = { spawns: 0, promptSessions: [] }
    const createTransport = makeTransportFactory(log)

    const first = await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    assert.equal(first.fresh, true)
    const chunks: StreamChunk[] = []
    first.entry.open.handlers.current = sink(chunks)
    const turn1 = await runAcpSessionPrompt(first.entry.open, 'one', undefined)
    assert.equal(turn1.stopReason, 'end_turn')

    const second = await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    assert.equal(second.fresh, false)
    assert.equal(second.entry, first.entry)
    const turn2 = await runAcpSessionPrompt(second.entry.open, 'two', undefined)
    assert.equal(turn2.stopReason, 'end_turn')

    assert.equal(log.spawns, 1, 'both turns must share one agent process')
    assert.equal(log.promptSessions.length, 2)
    assert.equal(
      log.promptSessions[0],
      log.promptSessions[1],
      'both prompts must land on the same ACP session',
    )
    assert.deepEqual(
      chunks.filter((c) => c.type === 'text'),
      [
        { type: 'text', text: 'echo:one' },
        { type: 'text', text: 'echo:two' },
      ],
    )
  })

  it('threads do not share sessions, and a config change respawns', async () => {
    const log: AgentLog = { spawns: 0, promptSessions: [] }
    const createTransport = makeTransportFactory(log)

    await acquireAcpSession({ threadId: 'a', config: CONFIG, createTransport })
    await acquireAcpSession({ threadId: 'b', config: CONFIG, createTransport })
    assert.equal(log.spawns, 2)
    assert.equal(acpSessionPoolSize(), 2)

    // Same thread, different spawn-relevant config → evict + respawn.
    const changed = await acquireAcpSession({
      threadId: 'a',
      config: { ...CONFIG, args: ['--different'] },
      createTransport,
    })
    assert.equal(changed.fresh, true)
    assert.equal(log.spawns, 3)
    assert.equal(acpSessionPoolSize(), 2)
  })

  it('dispose and idle-reap evict; the next acquire is fresh', async () => {
    const log: AgentLog = { spawns: 0, promptSessions: [] }
    const createTransport = makeTransportFactory(log)

    await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    disposeAcpSession('t1')
    assert.equal(acpSessionPoolSize(), 0)

    const reacquired = await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    assert.equal(reacquired.fresh, true)

    // Idle reaping: nothing at now, evicted once past the idle window.
    assert.deepEqual(reapIdleAcpSessions(Date.now(), 60_000), [])
    const reaped = reapIdleAcpSessions(Date.now() + 61_000, 60_000)
    assert.deepEqual(reaped, ['t1'])
    assert.equal(acpSessionPoolSize(), 0)
  })

  it('a disposed session reports closed so acquire never reuses it', async () => {
    const log: AgentLog = { spawns: 0, promptSessions: [] }
    const createTransport = makeTransportFactory(log)
    const { entry } = await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    entry.dispose()
    assert.equal(entry.open.isClosed(), true)
    const next = await acquireAcpSession({ threadId: 't1', config: CONFIG, createTransport })
    assert.equal(next.fresh, true)
    assert.equal(log.spawns, 2)
  })
})
