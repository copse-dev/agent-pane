import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * Stop-button behaviour for ACP turns (branch `cursor-acp-stop-button`).
 *
 * Pressing Stop aborts the turn's signal, which sends `session/cancel`. A
 * compliant agent answers that promptly, so the turn ends and the warm session
 * survives. An agent that ignores the cancel — the reported Cursor symptom —
 * must not hang the turn forever: once the grace window elapses the session is
 * torn down and the turn reports `cancelled`, so Stop always takes effect.
 *
 * Both are exercised against Copse's own in-process ACP agent over real ndjson
 * framing, injected through the pool's transport seam.
 */

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/cancel-test' }

function runnerTransport(runner: AcpTurnRunner): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  return () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = buildAcpAgentApp(runner, { name: 'cancel-test-agent' }).connect(
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

/** Resolve once `signal` is aborted, tolerating an already-aborted signal — the
 * in-process cancel propagates within a microtask, so a plain `addEventListener`
 * can miss the edge. */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve()
      },
      { once: true },
    )
  })
}

/** Handlers that trip `controller` the moment the first text chunk lands, so the
 * abort fires mid-turn exactly like the user pressing Stop while the agent works. */
function abortOnFirstChunk(controller: AbortController, into: StreamChunk[]): AcpClientHandlers {
  return {
    onChunk: (chunk): void => {
      into.push(chunk)
      if (chunk.type === 'text') controller.abort()
    },
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
  }
}

describe('acp stop button', () => {
  afterEach(() => {
    disposeAllAcpSessions()
  })

  it('a compliant agent honors session/cancel: the turn settles and the session stays warm', async () => {
    // Streams, then waits for the client's cancel and throws — the agent server
    // maps an aborted turn to the `cancelled` stop reason.
    const runner: AcpTurnRunner = async (ctx) => {
      await ctx.emit({ type: 'text', text: 'working' })
      await whenAborted(ctx.signal)
      return { stopReason: 'cancelled' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 't1',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = abortOnFirstChunk(controller, chunks)

    const result = await runAcpSessionPrompt(entry.open, 'go', undefined, controller.signal)

    assert.equal(result.stopReason, 'cancelled')
    assert.equal(
      entry.open.isClosed(),
      false,
      'a cancel the agent honors leaves the session reusable',
    )
  })

  it('a stuck agent that ignores session/cancel is torn down after the grace window', async () => {
    // Emits once, then hangs forever — never observes its abort signal, never
    // sends a stop. Without a bounded grace this would spin the turn indefinitely.
    const runner: AcpTurnRunner = async (ctx) => {
      await ctx.emit({ type: 'text', text: 'working' })
      await new Promise<void>(() => {})
      return { stopReason: 'end_turn' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 't1',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = abortOnFirstChunk(controller, chunks)

    // Short grace so the test doesn't wait the full production window.
    const result = await runAcpSessionPrompt(entry.open, 'go', undefined, controller.signal, 20)

    assert.equal(result.stopReason, 'cancelled')
    assert.equal(
      entry.open.isClosed(),
      true,
      'a stuck agent is disposed so Stop takes effect and the pool respawns next turn',
    )
  })

  it('stops surfacing agent chunks to the UI once the turn is aborted', async () => {
    // Two chunks: the first trips the abort, the second must never reach the UI.
    const runner: AcpTurnRunner = async (ctx) => {
      await ctx.emit({ type: 'text', text: 'first' })
      await ctx.emit({ type: 'text', text: 'second-after-abort' })
      await new Promise<void>(() => {})
      return { stopReason: 'end_turn' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 't1',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = abortOnFirstChunk(controller, chunks)

    await runAcpSessionPrompt(entry.open, 'go', undefined, controller.signal, 20)

    const texts = chunks.flatMap((c) => (c.type === 'text' ? [c.text] : []))
    assert.deepEqual(texts, ['first'], 'chunks after abort must not be forwarded')
  })
})
