import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { ACP_SESSION_STARTUP_TIMEOUT_MS, openAcpSession, type AcpTransport } from './acp-client.ts'

/**
 * An agent that never answers: its end of the pipe is never read, so
 * `initialize` stays pending until the client gives up on it.
 */
function silentAgentTransport(): {
  transport: () => Promise<AcpTransport>
  disposed: () => boolean
} {
  let disposed = false
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  return {
    transport: () =>
      Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: () => {
          disposed = true
        },
      }),
    disposed: () => disposed,
  }
}

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/acp-startup-test' }

describe('openAcpSession startup', () => {
  afterEach(() => {
    mock.timers.reset()
  })

  it('gives up on a hung initialize when the run is stopped', async () => {
    const agent = silentAgentTransport()
    const controller = new AbortController()
    const opening = openAcpSession(
      CONFIG,
      { current: null },
      agent.transport,
      undefined,
      null,
      controller.signal,
    )
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await assert.rejects(opening, { name: 'AbortError' })
    assert.equal(agent.disposed(), true, 'the hung agent is torn down')
  })

  it('does not start a session for a run that was already stopped', async () => {
    const agent = silentAgentTransport()
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      openAcpSession(
        CONFIG,
        { current: null },
        agent.transport,
        undefined,
        null,
        controller.signal,
      ),
      { name: 'AbortError' },
    )
    assert.equal(agent.disposed(), true)
  })

  it('fails a startup the agent never answers once the deadline passes', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const agent = silentAgentTransport()
    const opening = openAcpSession(CONFIG, { current: null }, agent.transport)
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(ACP_SESSION_STARTUP_TIMEOUT_MS)

    await assert.rejects(opening, /did not finish starting/)
    assert.equal(agent.disposed(), true)
  })
})
