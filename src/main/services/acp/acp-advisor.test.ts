import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import type { AcpTransportFactory } from './acp-client.ts'
import { runAcpAdvisorSession } from './acp-advisor.ts'

/**
 * The bare ACP advisor session (`acp-advisor.ts`) over an in-memory loopback:
 * Copse's own ACP agent half plays the external advisor agent, so the full
 * initialize → session/new → prompt → updates → stop round trip runs with no
 * subprocess. Pins the "bare" contract: advice text is collected, and any
 * permission the agent requests is auto-rejected.
 */
function loopbackTransport(runner: AcpTurnRunner): AcpTransportFactory {
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  buildAcpAgentApp(runner, { name: 'advisor-test-agent' }).connect(
    ndJsonStream(a2c.writable, c2a.readable),
  )
  return () =>
    Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: (): void => {},
    })
}

describe('runAcpAdvisorSession', () => {
  it('collects the agent’s advice text and reports estimated usage', async () => {
    const prompts: string[] = []
    const runner: AcpTurnRunner = async (ctx) => {
      prompts.push(ctx.prompt)
      await ctx.emit({ type: 'text', text: 'Advice: ship the smallest slice first.' })
      return { stopReason: 'end_turn' }
    }

    const result = await runAcpAdvisorSession(
      { command: 'unused', cwd: '/tmp/project' },
      undefined,
      'Executor transcript goes here.',
      new AbortController().signal,
      loopbackTransport(runner),
    )

    assert.deepEqual(prompts, ['Executor transcript goes here.'])
    assert.equal(result.text, 'Advice: ship the smallest slice first.')
    // No usage reported by the loopback agent, so the ~4 chars/token estimate applies.
    assert.ok(result.usage.inputTokens > 0)
    assert.ok(result.usage.outputTokens > 0)
  })

  it('auto-rejects any permission the advisor agent requests (bare contract)', async () => {
    const decisions: string[] = []
    const runner: AcpTurnRunner = async (ctx) => {
      const decision = await ctx.requestPermission({
        toolCallId: 't1',
        title: 'run_shell',
        rawInput: { command: 'ls' },
      })
      decisions.push(decision)
      await ctx.emit({ type: 'text', text: 'Advice without tools.' })
      return { stopReason: 'end_turn' }
    }

    const result = await runAcpAdvisorSession(
      { command: 'unused', cwd: '/tmp/project' },
      undefined,
      'transcript',
      new AbortController().signal,
      loopbackTransport(runner),
    )

    assert.deepEqual(decisions, ['reject'])
    assert.equal(result.text, 'Advice without tools.')
  })
})
