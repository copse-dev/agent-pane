import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnContext, type AcpTurnRunner } from './acp-agent-server.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * Between-turn update delivery (issue #588). A pooled agent's background
 * helpers can finish AFTER the turn that launched them settled; their
 * `session/update`s used to queue invisibly until the user's next message.
 * The session's update pump (`startAcpUpdatePump` in acp-client.ts) now
 * forwards them to the most recent chunk sink as they arrive, so completed
 * background work surfaces in the thread while it is idle.
 *
 * Exercised against Copse's own in-process ACP agent over real ndjson framing,
 * injected through the pool's transport seam — the same loopback pattern as
 * acp-session-pool.test.ts.
 */

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/idle-updates-test' }

function runnerTransport(runner: AcpTurnRunner): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  return () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = buildAcpAgentApp(runner, { name: 'idle-updates-test-agent' }).connect(
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

/** Poll until `cond` holds — between-turn updates arrive asynchronously over
 * the loopback pipes, with no turn promise to await. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Resolve once `signal` is aborted, tolerating an already-aborted signal. */
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

describe('acp between-turn updates (issue #588)', () => {
  afterEach(() => {
    disposeAllAcpSessions()
  })

  it('surfaces updates that arrive after the turn settled, without a new prompt', async () => {
    // The runner leaks its turn context so the test can emit updates on the
    // still-open session AFTER the prompt returned — exactly what an agent's
    // background subagent does when it finishes between turns.
    const contexts: AcpTurnContext[] = []
    const runner: AcpTurnRunner = async (ctx) => {
      contexts.push(ctx)
      await ctx.emit({ type: 'text', text: 'launched background work' })
      return { stopReason: 'end_turn' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 't1',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = sink(chunks)

    const turn = await runAcpSessionPrompt(entry.open, 'go', undefined)
    assert.equal(turn.stopReason, 'end_turn')
    const turnCtx = contexts[0]
    assert.ok(turnCtx, 'runner must have run')
    const idleChunkCount = chunks.length

    // The thread is idle. A background helper reports back through the same
    // session — its tool activity must reach the sink with no new prompt.
    await turnCtx.emit({
      type: 'tool_call',
      toolCall: { id: 'bg1', name: 'background_review', args: { scope: 'diff' } },
    })
    await turnCtx.emit({
      type: 'tool_result',
      toolCallId: 'bg1',
      result: 'found 2 issues',
      isError: false,
    })
    await until(() => chunks.some((c) => c.type === 'tool_result'))

    const idle = chunks.slice(idleChunkCount)
    assert.deepEqual(
      idle.find((c) => c.type === 'tool_call')?.toolCall,
      { id: 'bg1', name: 'background_review', args: { scope: 'diff' } },
      'the background tool call must surface while idle',
    )
    const result = idle.find((c) => c.type === 'tool_result')
    assert.equal(result?.result, 'found 2 issues')
  })

  it('keeps between-turn updates suppressed after a cancelled turn, until the next turn', async () => {
    const contexts: AcpTurnContext[] = []
    const runner: AcpTurnRunner = async (ctx) => {
      contexts.push(ctx)
      if (ctx.prompt === 'cancel-me') {
        await ctx.emit({ type: 'text', text: 'working' })
        await whenAborted(ctx.signal)
        return { stopReason: 'cancelled' }
      }
      await ctx.emit({ type: 'text', text: `echo:${ctx.prompt}` })
      return { stopReason: 'end_turn' }
    }
    const { entry } = await acquireAcpSession({
      threadId: 't1',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const controller = new AbortController()
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = {
      ...sink(chunks),
      onChunk: (chunk): void => {
        chunks.push(chunk)
        if (chunk.type === 'text' && chunk.text === 'working') controller.abort()
      },
    }

    const cancelled = await runAcpSessionPrompt(
      entry.open,
      'cancel-me',
      undefined,
      controller.signal,
    )
    assert.equal(cancelled.stopReason, 'cancelled')

    // A trailing update from the cancelled turn's leftovers must stay hidden…
    const firstCtx = contexts[0]
    assert.ok(firstCtx)
    await firstCtx.emit({ type: 'text', text: 'late-after-cancel' })
    // Fence: an agent→client request is dispatched by the client strictly
    // after the notify above, so its response proves the suppressed update was
    // consumed BEFORE the next turn re-enables forwarding — without this,
    // starting turn 2 races the in-flight 'late-after-cancel'.
    await firstCtx.requestPermission({ toolCallId: 'fence', title: 'fence' })

    // …while the next turn surfaces normally.
    const second = await runAcpSessionPrompt(entry.open, 'two', undefined)
    assert.equal(second.stopReason, 'end_turn')

    const texts = chunks.flatMap((c) => (c.type === 'text' ? [c.text] : []))
    assert.deepEqual(
      texts,
      ['working', 'echo:two'],
      'output after a cancel stays hidden; the next turn streams again',
    )
  })
})
