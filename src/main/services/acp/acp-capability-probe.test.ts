import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type SessionModeState,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk'
import {
  extractCapabilitySnapshot,
  probeAgentCapabilities,
  type AcpProbeConfig,
  type AcpProbeOptions,
} from './acp-capability-probe.ts'
import { buildMatrixJson, renderMatrixMarkdown } from './acp-support-matrix.ts'

/**
 * Stand up an in-memory ACP agent with fully controllable `initialize` /
 * `session/new` responses, wire it to the probe through a pair of byte pipes
 * (no subprocess), and assert the probe reads back exactly what the agent
 * advertised. This is the deterministic, binary-free core of the Tier-1 eval:
 * it proves the probe's extraction without any agent installed.
 */
interface FakeAgentSpec {
  agentCapabilities?: AgentCapabilities
  authMethods?: AuthMethod[]
  agentInfo?: { name: string; version: string; title?: string }
  initMeta?: Record<string, unknown>
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
  sessionMeta?: Record<string, unknown>
  /** Commands the agent pushes via `available_commands_update` right after `session/new`. */
  pushCommands?: string[]
}

type TransportFactory = NonNullable<AcpProbeOptions['createTransport']>

function fakeAgentTransport(spec: FakeAgentSpec): TransportFactory {
  return (_config: AcpProbeConfig) => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)
    const pushCommands = spec.pushCommands ?? []

    agent({ name: 'fake-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        ...(spec.agentCapabilities ? { agentCapabilities: spec.agentCapabilities } : {}),
        ...(spec.authMethods ? { authMethods: spec.authMethods } : {}),
        ...(spec.agentInfo
          ? {
              agentInfo: {
                name: spec.agentInfo.name,
                version: spec.agentInfo.version,
                title: spec.agentInfo.title ?? null,
              },
            }
          : {}),
        ...(spec.initMeta ? { _meta: spec.initMeta } : {}),
      }))
      .onRequest('authenticate', () => ({}))
      .onRequest('session/new', (ctx) => {
        const sessionId = 'sess-1'
        if (pushCommands.length > 0) {
          const peer = ctx.client
          // Fire after the response is delivered so the client's session exists.
          setTimeout(() => {
            void peer.notify(methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: pushCommands.map((name) => ({
                  name,
                  description: `${name} command`,
                })),
              },
            })
          }, 0)
        }
        return {
          sessionId,
          ...(spec.modes ? { modes: spec.modes } : {}),
          ...(spec.configOptions ? { configOptions: spec.configOptions } : {}),
          ...(spec.sessionMeta ? { _meta: spec.sessionMeta } : {}),
        }
      })
      .onNotification('session/cancel', () => {})
      .connect(agentStream)

    return Promise.resolve({ stream: clientStream, dispose: () => {} })
  }
}

const CONFIG: AcpProbeConfig = {
  agentId: 'fake',
  title: 'Fake Agent',
  command: 'fake-agent',
  args: [],
  cwd: '/tmp/project',
}

describe('extractCapabilitySnapshot', () => {
  it('maps a rich initialize/session response into the snapshot', () => {
    const snapshot = extractCapabilitySnapshot(
      {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { list: {}, resume: {}, fork: {} },
          providers: {},
        },
        authMethods: [{ type: 'env_var', id: 'api-key', name: 'API key' }],
        agentInfo: { name: 'claude-code-acp', version: '1.2.3', title: null },
        _meta: { 'anthropic.com/betas': ['x'] },
      },
      {
        sessionId: 's',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'sonnet',
            options: [
              { value: 'sonnet', name: 'Sonnet' },
              { value: 'opus', name: 'Opus' },
            ],
          },
        ],
        _meta: { 'zed.dev/x': 1 },
      },
      [
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: 'compact' }],
        },
      ],
    )

    assert.equal(snapshot.loadSession, true)
    assert.equal(snapshot.sessionResume, true)
    assert.equal(snapshot.sessionList, true)
    assert.equal(snapshot.sessionFork, true)
    assert.equal(snapshot.promptImage, true)
    assert.equal(snapshot.promptAudio, false)
    assert.equal(snapshot.promptEmbeddedContext, true)
    assert.equal(snapshot.mcpHttp, true)
    assert.equal(snapshot.mcpSse, false)
    assert.deepEqual(snapshot.modes, { current: 'default', available: ['default', 'plan'] })
    assert.equal(snapshot.models?.count, 2)
    assert.equal(snapshot.models?.current, 'sonnet')
    assert.deepEqual(snapshot.authMethods, [{ id: 'api-key', name: 'API key' }])
    assert.deepEqual(snapshot.slashCommands, ['compact'])
    assert.deepEqual(snapshot.observedUpdateKinds, ['available_commands_update'])
    assert.ok(snapshot.unstableCapabilities.includes('providers'))
    assert.ok(snapshot.unstableCapabilities.includes('sessionCapabilities.fork'))
    assert.deepEqual(snapshot.meta.initialize, { 'anthropic.com/betas': ['x'] })
    assert.deepEqual(snapshot.metaKeys, ['initialize:anthropic.com/betas', 'session/new:zed.dev/x'])
    assert.equal(snapshot.agentInfo?.version, '1.2.3')
  })

  it('handles a bare agent with no advertised capabilities', () => {
    const snapshot = extractCapabilitySnapshot({ protocolVersion: 1 }, { sessionId: 's' })
    assert.equal(snapshot.loadSession, false)
    assert.equal(snapshot.mcpHttp, false)
    assert.equal(snapshot.modes, null)
    assert.equal(snapshot.models, null)
    assert.deepEqual(snapshot.authMethods, [])
    assert.deepEqual(snapshot.slashCommands, [])
    assert.deepEqual(snapshot.metaKeys, [])
    assert.equal(snapshot.agentInfo, null)
    assert.deepEqual(snapshot.unstableCapabilities, [])
  })
})

describe('probeAgentCapabilities (in-memory agent)', () => {
  it('probes a rich agent end-to-end and harvests pushed commands + _meta', async () => {
    const report = await probeAgentCapabilities(CONFIG, {
      settleMs: 200,
      createTransport: fakeAgentTransport({
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {} },
        },
        authMethods: [{ type: 'env_var', id: 'api-key', name: 'API key' }],
        agentInfo: { name: 'fake', version: '9.9.9' },
        initMeta: { 'vendor/feature': true },
        pushCommands: ['plan', 'compact'],
      }),
    })

    assert.equal(report.ok, true)
    assert.equal(report.snapshot?.loadSession, true)
    assert.equal(report.snapshot?.sessionResume, true)
    assert.equal(report.snapshot?.promptImage, true)
    assert.equal(report.snapshot?.mcpHttp, true)
    assert.equal(report.snapshot?.agentInfo?.version, '9.9.9')
    assert.deepEqual(report.snapshot?.slashCommands, ['plan', 'compact'])
    assert.deepEqual(report.snapshot?.metaKeys, ['initialize:vendor/feature'])
  })

  it('probes a bare agent without pushed updates', async () => {
    const report = await probeAgentCapabilities(CONFIG, {
      settleMs: 50,
      createTransport: fakeAgentTransport({}),
    })
    assert.equal(report.ok, true)
    assert.equal(report.snapshot?.loadSession, false)
    assert.deepEqual(report.snapshot?.slashCommands, [])
  })

  it('captures a transport failure as ok:false instead of throwing', async () => {
    const report = await probeAgentCapabilities(CONFIG, {
      settleMs: 0,
      createTransport: () => Promise.reject(new Error('spawn ENOENT')),
    })
    assert.equal(report.ok, false)
    assert.match(report.error ?? '', /ENOENT/)
    assert.equal(report.snapshot, undefined)
  })

  it('records the requested protocol version (forward hook for v2)', async () => {
    // The default fake agent always answers v1; requesting v2 surfaces the
    // negotiate-down so the matrix can flag it.
    const report = await probeAgentCapabilities(CONFIG, {
      settleMs: 0,
      protocolVersion: 2,
      createTransport: fakeAgentTransport({}),
    })
    assert.equal(report.requestedProtocolVersion, 2)
    assert.equal(report.snapshot?.protocolVersion, PROTOCOL_VERSION)
    assert.notEqual(report.snapshot?.protocolVersion, report.requestedProtocolVersion)
  })
})

describe('renderMatrixMarkdown / buildMatrixJson', () => {
  it('renders a comparison table with per-agent detail', async () => {
    const rich = await probeAgentCapabilities(
      { ...CONFIG, agentId: 'rich', title: 'Rich' },
      {
        settleMs: 100,
        createTransport: fakeAgentTransport({
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
          agentInfo: { name: 'rich', version: '2.0.0' },
          pushCommands: ['plan'],
        }),
      },
    )
    const failed = await probeAgentCapabilities(
      { ...CONFIG, agentId: 'broken', title: 'Broken' },
      { settleMs: 0, createTransport: () => Promise.reject(new Error('nope')) },
    )

    const md = renderMatrixMarkdown([rich, failed], { probedAt: '2026-07-12T00:00:00Z' })
    assert.match(md, /# ACP agent support matrix/)
    assert.match(md, /\| Capability \| Rich \| Broken \|/)
    assert.match(md, /Session load \(resume prior\)/)
    assert.match(md, /_\(unstable\)_/) // fork/acp rows carry the marker
    assert.match(md, /\*\*Probe failed:\*\* nope/)
    // Slash-command count renders as a lower bound (async discovery race).
    assert.match(md, /≥1/)
    // Rich agent supports loadSession (✓); broken agent column is unknown (—).
    const loadRow = md.split('\n').find((l) => l.startsWith('| Session load'))
    assert.ok(loadRow?.includes('✓'))
    assert.ok(loadRow?.includes('—'))

    const json = buildMatrixJson([rich, failed], { probedAt: '2026-07-12T00:00:00Z' })
    assert.equal(json.reports.length, 2)
    assert.equal(json.generatedBy, 'npm run probe:acp')
    // Round-trips through JSON without loss.
    const roundTripped = JSON.parse(JSON.stringify(json)) as typeof json
    assert.equal(roundTripped.reports[0]?.snapshot?.loadSession, true)
  })
})
