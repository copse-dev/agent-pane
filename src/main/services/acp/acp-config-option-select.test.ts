import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk'
import type { AcpTransportFactory } from './acp-client.ts'
import {
  configOptionsFrom,
  modelSelectorFrom,
  openAcpSession,
  runAcpSessionPrompt,
} from './acp-client.ts'

/**
 * ACP session **config options** beyond the model — reasoning level
 * (`category: "thought_level"`) and anything else an agent advertises.
 * `configOptionsFrom` flattens them out of a `session/new` response for the
 * picker; `openAcpSession` then applies the user's stored selections via
 * `session/set_config_option` before the first prompt, and re-applies them when
 * the selection moves between turns. The integration cases drive a real
 * in-process ACP agent over ndjson framing and assert exactly which
 * `session/set_config_option` requests are — and are not — sent.
 */

const SESSION_CONFIG: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'sonnet',
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low', description: 'Answer fast' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

describe('configOptionsFrom', () => {
  it('flattens every select option, including grouped choices', () => {
    const options = configOptionsFrom({
      configOptions: [
        ...SESSION_CONFIG,
        {
          id: 'verbosity',
          name: 'Verbosity',
          type: 'select',
          currentValue: 'normal',
          options: [
            { group: 'Short', options: [{ value: 'terse', name: 'Terse' }] },
            { value: 'normal', name: 'Normal' },
          ],
        },
      ],
    })

    assert.deepEqual(
      options.map((option) => [option.configId, option.category, option.name]),
      [
        ['model', 'model', 'Model'],
        ['thinking', 'thought_level', 'Thinking effort'],
        // No category on the wire is not a reason to hide the option — ACP says
        // the field is a UX hint and clients must handle it missing.
        ['verbosity', 'other', 'Verbosity'],
      ],
    )
    assert.deepEqual(options[1]?.choices, [
      { value: 'low', label: 'Low', description: 'Answer fast' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ])
    assert.deepEqual(options[2]?.choices, [
      { value: 'terse', label: 'Terse' },
      { value: 'normal', label: 'Normal' },
    ])
  })

  it('normalizes unknown and vendor categories to "other"', () => {
    const [unknown, vendor] = configOptionsFrom({
      configOptions: [
        { id: 'a', name: 'A', category: 'from_a_later_spec', type: 'select', currentValue: 'x' },
        { id: 'b', name: 'B', category: '_acme.com/thing', type: 'select', currentValue: 'x' },
      ],
    })

    assert.equal(unknown?.category, 'other')
    assert.equal(vendor?.category, 'other')
  })

  it('ignores non-select options and malformed entries', () => {
    assert.deepEqual(
      configOptionsFrom({
        configOptions: [
          { id: 'toggle', name: 'Toggle', type: 'boolean', currentValue: true },
          { id: 'no-current', name: 'Broken', type: 'select' },
          'not-an-object',
        ],
      }),
      [],
    )
    assert.deepEqual(configOptionsFrom({}), [])
    assert.deepEqual(configOptionsFrom({ configOptions: null }), [])
  })

  it('still backs the model selector, which is one category of the same list', () => {
    assert.deepEqual(modelSelectorFrom({ configOptions: SESSION_CONFIG }), {
      configId: 'model',
      currentValue: 'sonnet',
      choices: [
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'opus', label: 'Opus' },
      ],
    })
  })
})

interface SetConfigCall {
  configId: string
  value: unknown
}

/** An in-process agent recording every `session/set_config_option` it receives. */
function makeConfigAgent(opts: {
  configOptions: SessionConfigOption[]
  calls: SetConfigCall[]
  prompts: number[]
}): AgentApp {
  return agent({ name: 'config-option-test-agent' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest('session/new', () => ({
      sessionId: 'sess-1',
      configOptions: opts.configOptions,
    }))
    .onRequest('session/set_config_option', (ctx) => {
      opts.calls.push({ configId: ctx.params.configId, value: ctx.params.value })
      // ACP has the agent echo the full, updated option set back.
      return { configOptions: opts.configOptions }
    })
    .onRequest('session/prompt', () => {
      opts.prompts.push(1)
      return { stopReason: 'end_turn' }
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

async function openWith(
  configOptions: Record<string, string> | undefined,
  advertised: SessionConfigOption[] = SESSION_CONFIG,
): Promise<{ calls: SetConfigCall[]; open: Awaited<ReturnType<typeof openAcpSession>> }> {
  const calls: SetConfigCall[] = []
  const prompts: number[] = []
  const app = makeConfigAgent({ configOptions: advertised, calls, prompts })
  const open = await openAcpSession(
    { command: 'x', cwd: '/tmp/config-option-test', ...(configOptions ? { configOptions } : {}) },
    { current: null },
    transportFor(app),
  )
  return { calls, open }
}

describe('openAcpSession applies stored config options', () => {
  it('sends set_config_option for a stored, offered, non-current value', async () => {
    const { calls, open } = await openWith({ thinking: 'high' })
    open.dispose()
    assert.deepEqual(calls, [{ configId: 'thinking', value: 'high' }])
  })

  it('does not switch when the stored value is already the agent’s current one', async () => {
    const { calls, open } = await openWith({ thinking: 'medium' })
    open.dispose()
    assert.deepEqual(calls, [])
  })

  it('skips a value the agent no longer offers, and an unknown option id', async () => {
    const { calls, open } = await openWith({ thinking: 'ultra', missing: 'x' })
    open.dispose()
    assert.deepEqual(calls, [])
  })

  it('does nothing when the agent advertises no config options', async () => {
    const { calls, open } = await openWith({ thinking: 'high' }, [])
    open.dispose()
    assert.deepEqual(calls, [])
  })

  it('applies several stored options in one session', async () => {
    const { calls, open } = await openWith({ thinking: 'low', model: 'opus' })
    open.dispose()
    assert.deepEqual(calls, [
      { configId: 'thinking', value: 'low' },
      { configId: 'model', value: 'opus' },
    ])
  })
})

describe('config options switch live between turns', () => {
  it('re-applies only what changed, without respawning the session', async () => {
    const { calls, open } = await openWith({ thinking: 'high' })
    try {
      assert.deepEqual(calls, [{ configId: 'thinking', value: 'high' }])

      // Same selection next turn: nothing re-sent.
      await runAcpSessionPrompt(open, 'one', undefined)
      assert.equal(calls.length, 1)

      // The user picks a new reasoning level between turns — the pool hands the
      // fresh selection to the open session, which applies it on the next turn.
      open.desiredConfigOptions = { thinking: 'low' }
      await runAcpSessionPrompt(open, 'two', undefined)
      assert.deepEqual(calls, [
        { configId: 'thinking', value: 'high' },
        { configId: 'thinking', value: 'low' },
      ])
    } finally {
      open.dispose()
    }
  })

  it('leaves the session on the agent’s value when the new pick is not offered', async () => {
    const { calls, open } = await openWith(undefined)
    try {
      open.desiredConfigOptions = { thinking: 'ludicrous' }
      await runAcpSessionPrompt(open, 'one', undefined)
      assert.deepEqual(calls, [])
    } finally {
      open.dispose()
    }
  })
})
