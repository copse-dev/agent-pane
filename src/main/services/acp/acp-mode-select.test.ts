import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type NewSessionResponse,
  type SessionModeState,
} from '@agentclientprotocol/sdk'
import type { AcpTransportFactory } from './acp-client.ts'
import { modeSelectorFrom, openAcpSession } from './acp-client.ts'

/**
 * ACP session (permission) modes, issue #607. `modeSelectorFrom` picks the
 * `modes` state out of a `session/new` response for the settings picker;
 * `openAcpSession` then applies the configured mode via `session/set_mode`
 * before the first prompt. The integration cases drive a real in-process ACP
 * agent over ndjson framing (same loopback pattern as the pool tests) and assert
 * exactly when `session/set_mode` is — and isn't — sent.
 */
describe('modeSelectorFrom', () => {
  it('flattens the agent’s advertised session modes', () => {
    const response = {
      sessionId: 's1',
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default', description: 'Ask before edits' },
          { id: 'acceptEdits', name: 'Accept edits' },
        ],
      },
    } as unknown as NewSessionResponse

    assert.deepEqual(modeSelectorFrom(response), {
      currentValue: 'default',
      choices: [
        { value: 'default', label: 'Default', description: 'Ask before edits' },
        { value: 'acceptEdits', label: 'Accept edits' },
      ],
    })
  })

  it('returns null when the agent advertises no modes', () => {
    assert.equal(modeSelectorFrom({}), null)
    assert.equal(modeSelectorFrom({ modes: null }), null)
    assert.equal(modeSelectorFrom({ modes: { currentModeId: 'x', availableModes: [] } }), null)
  })
})

const MODES: SessionModeState = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'acceptEdits', name: 'Accept edits' },
    { id: 'plan', name: 'Plan' },
  ],
}

/** An in-process ACP agent that records every `session/set_mode` it receives. */
function makeModeAgent(opts: { modes: SessionModeState | null; setModeCalls: string[] }): AgentApp {
  return agent({ name: 'mode-test-agent' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest('session/new', () => ({
      sessionId: 'sess-1',
      ...(opts.modes ? { modes: opts.modes } : {}),
    }))
    .onRequest('session/set_mode', (ctx) => {
      opts.setModeCalls.push(ctx.params.modeId)
      return {}
    })
}

function transportFor(app: AgentApp): AcpTransportFactory {
  return () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = app.connect(ndJsonStream(a2c.writable, c2a.readable))
    return Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: () => {
        agentConnection.close()
      },
    })
  }
}

async function openWithMode(
  permissionMode: string | undefined,
  modes: SessionModeState | null,
): Promise<string[]> {
  const setModeCalls: string[] = []
  const app = makeModeAgent({ modes, setModeCalls })
  const open = await openAcpSession(
    { command: 'x', cwd: '/tmp/mode-test', ...(permissionMode ? { permissionMode } : {}) },
    { current: null },
    transportFor(app),
  )
  open.dispose()
  return setModeCalls
}

describe('openAcpSession applies the session mode (issue #607)', () => {
  it('sends session/set_mode for a configured, offered, non-current mode', async () => {
    assert.deepEqual(await openWithMode('acceptEdits', MODES), ['acceptEdits'])
  })

  it('does not switch when the requested mode is already the current one', async () => {
    assert.deepEqual(await openWithMode('default', MODES), [])
  })

  it('skips a mode the agent does not advertise (degrades to its default)', async () => {
    assert.deepEqual(await openWithMode('bogus', MODES), [])
  })

  it('does nothing when no mode is configured', async () => {
    assert.deepEqual(await openWithMode(undefined, MODES), [])
  })

  it('does nothing when the agent advertises no modes at all', async () => {
    assert.deepEqual(await openWithMode('acceptEdits', null), [])
  })
})
