import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
} from '@agentclientprotocol/sdk'
import {
  DEFAULT_BEHAVIOR_PROMPT,
  extractBehaviorSnapshot,
  probeAgentBehavior,
  type AcpBehaviorProbeConfig,
  type AcpBehaviorProbeOptions,
} from './acp-behavior-probe.ts'
import { buildBehaviorMatrixJson, renderBehaviorMatrixMarkdown } from './acp-behavior-matrix.ts'

/**
 * In-memory ACP agents with scripted turn behaviour for the Tier-2 probe.
 * Each script exercises one of the three observations #832 cares about:
 * write routing, permission payloads, and mid-turn `_meta`.
 */

type BehaviorScript = 'fs-write' | 'shell-execute' | 'permission-meta' | 'both'

type TransportFactory = NonNullable<AcpBehaviorProbeOptions['createTransport']>

function fakeBehaviorTransport(script: BehaviorScript): TransportFactory {
  return (_config: AcpBehaviorProbeConfig) => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)

    agent({ name: 'fake-behavior-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          promptCapabilities: { image: true },
        },
      }))
      .onRequest('authenticate', () => ({}))
      .onRequest('session/new', () => ({ sessionId: 'sess-behavior-1' }))
      .onRequest('session/prompt', async (ctx) => {
        const peer = ctx.client
        const sessionId = ctx.params.sessionId
        const promptText = promptToText(ctx.params.prompt)

        await peer.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `ack:${promptText.slice(0, 24)}` },
            ...(script === 'permission-meta' ? { _meta: { 'vendor.com/turn': 'start' } } : {}),
          },
        })

        if (script === 'fs-write' || script === 'both') {
          await peer.request(methods.client.fs.writeTextFile, {
            sessionId,
            path: '/tmp/project/.copse-acp-behavior-probe.txt',
            content: 'PROBE_OK',
            ...(script === 'both' ? { _meta: { 'vendor.com/write': 1 } } : {}),
          })
        }

        if (script === 'shell-execute' || script === 'both' || script === 'permission-meta') {
          const toolCallId = 'tc-1'
          await peer.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: 'echo PROBE_OK > .copse-acp-behavior-probe.txt',
              kind: 'execute',
              status: 'pending',
              rawInput: { command: 'echo PROBE_OK > .copse-acp-behavior-probe.txt' },
              ...(script === 'permission-meta' ? { _meta: { 'vendor.com/tool': 'shell' } } : {}),
            },
          })
          await peer.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: {
              toolCallId,
              title: 'echo PROBE_OK > .copse-acp-behavior-probe.txt',
              kind: 'execute',
              status: 'pending',
              rawInput: {
                command: 'echo PROBE_OK > .copse-acp-behavior-probe.txt',
                cwd: '/tmp/project',
              },
              ...(script === 'permission-meta' ? { _meta: { 'vendor.com/perm-tool': true } } : {}),
            },
            options: [
              { kind: 'allow_once', name: 'Allow', optionId: 'allow-once' },
              { kind: 'reject_once', name: 'Reject', optionId: 'reject-once' },
            ],
            ...(script === 'permission-meta'
              ? { _meta: { 'vendor.com/permission': 'shell' } }
              : {}),
          })
        }

        return { stopReason: 'end_turn' }
      })
      .onNotification('session/cancel', () => {})
      .connect(agentStream)

    return Promise.resolve({ stream: clientStream, dispose: () => {} })
  }
}

function promptToText(prompt: PromptRequest['prompt']): string {
  return prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

const CONFIG: AcpBehaviorProbeConfig = {
  agentId: 'fake',
  title: 'Fake Agent',
  command: 'fake-behavior-agent',
  args: [],
  cwd: '/tmp/project',
}

describe('extractBehaviorSnapshot', () => {
  it('classifies fs-only, execute-only, both, and none write routing', () => {
    assert.equal(
      extractBehaviorSnapshot({
        fsWrites: [{ path: '/a', contentBytes: 1, metaKeys: [] }],
        permissionRequests: [],
        toolCalls: [],
        updateKinds: [],
        midTurnMetaKeys: [],
        stopReason: 'end_turn',
      }).writeRouting,
      'fs_write_text_file',
    )
    assert.equal(
      extractBehaviorSnapshot({
        fsWrites: [],
        permissionRequests: [],
        toolCalls: [
          { toolCallId: 't', title: 'sh', kind: 'execute', status: 'pending', metaKeys: [] },
        ],
        updateKinds: [],
        midTurnMetaKeys: [],
        stopReason: 'end_turn',
      }).writeRouting,
      'shell_or_execute',
    )
    assert.equal(
      extractBehaviorSnapshot({
        fsWrites: [{ path: '/a', contentBytes: 1, metaKeys: [] }],
        permissionRequests: [],
        toolCalls: [
          { toolCallId: 't', title: 'sh', kind: 'execute', status: 'pending', metaKeys: [] },
        ],
        updateKinds: [],
        midTurnMetaKeys: [],
        stopReason: 'end_turn',
      }).writeRouting,
      'both',
    )
    assert.equal(
      extractBehaviorSnapshot({
        fsWrites: [],
        permissionRequests: [],
        toolCalls: [],
        updateKinds: [],
        midTurnMetaKeys: [],
        stopReason: null,
      }).writeRouting,
      'none',
    )
  })

  it('dedupes and sorts mid-turn meta keys', () => {
    const snapshot = extractBehaviorSnapshot({
      fsWrites: [],
      permissionRequests: [],
      toolCalls: [],
      updateKinds: ['tool_call', 'tool_call'],
      midTurnMetaKeys: ['z:b', 'a:c', 'z:b'],
      stopReason: 'end_turn',
    })
    assert.deepEqual(snapshot.midTurnMetaKeys, ['a:c', 'z:b'])
    assert.deepEqual(snapshot.updateKinds, ['tool_call'])
  })
})

describe('probeAgentBehavior (in-memory agent)', () => {
  it('detects fs/write_text_file routing', async () => {
    const report = await probeAgentBehavior(CONFIG, {
      createTransport: fakeBehaviorTransport('fs-write'),
      timeoutMs: 5_000,
    })
    assert.equal(report.ok, true)
    assert.ok(report.snapshot)
    assert.equal(report.snapshot.writeRouting, 'fs_write_text_file')
    assert.equal(report.snapshot.fsWrites.length, 1)
    assert.equal(report.snapshot.fsWrites[0]?.contentBytes, Buffer.byteLength('PROBE_OK', 'utf8'))
    assert.equal(report.snapshot.permissionRequests.length, 0)
    assert.equal(report.snapshot.stopReason, 'end_turn')
    assert.equal(report.prompt, DEFAULT_BEHAVIOR_PROMPT)
  })

  it('detects execute/shell write routing + permission payload shape', async () => {
    const report = await probeAgentBehavior(CONFIG, {
      createTransport: fakeBehaviorTransport('shell-execute'),
      timeoutMs: 5_000,
    })
    assert.equal(report.ok, true)
    assert.ok(report.snapshot)
    assert.equal(report.snapshot.writeRouting, 'shell_or_execute')
    assert.equal(report.snapshot.fsWrites.length, 0)
    assert.equal(report.snapshot.permissionRequests.length, 1)
    const perm = report.snapshot.permissionRequests[0]
    assert.ok(perm)
    assert.equal(perm.kind, 'execute')
    assert.deepEqual(perm.optionIds, ['allow-once', 'reject-once'])
    assert.deepEqual(perm.optionKinds, ['allow_once', 'reject_once'])
    assert.ok(perm.rawInputKeys.includes('command'))
    assert.ok(perm.rawInputKeys.includes('cwd'))
  })

  it('harvests mid-turn _meta from permissions, tools, and message chunks', async () => {
    const report = await probeAgentBehavior(CONFIG, {
      createTransport: fakeBehaviorTransport('permission-meta'),
      timeoutMs: 5_000,
    })
    assert.equal(report.ok, true)
    assert.ok(report.snapshot)
    const keys = report.snapshot.midTurnMetaKeys
    assert.ok(keys.includes('permission:vendor.com/permission'))
    assert.ok(keys.includes('permission.toolCall:vendor.com/perm-tool'))
    assert.ok(keys.includes('tool_call:vendor.com/tool'))
    assert.ok(keys.includes('update:agent_message_chunk:vendor.com/turn'))
  })

  it('classifies both when the agent writes via fs and execute', async () => {
    const report = await probeAgentBehavior(CONFIG, {
      createTransport: fakeBehaviorTransport('both'),
      timeoutMs: 5_000,
    })
    assert.equal(report.ok, true)
    assert.ok(report.snapshot)
    assert.equal(report.snapshot.writeRouting, 'both')
    assert.ok(report.snapshot.midTurnMetaKeys.includes('fs/write_text_file:vendor.com/write'))
  })
})

describe('behavior matrix rendering', () => {
  it('renders a markdown matrix and JSON snapshot from reports', async () => {
    const report = await probeAgentBehavior(CONFIG, {
      createTransport: fakeBehaviorTransport('fs-write'),
      timeoutMs: 5_000,
    })
    const md = renderBehaviorMatrixMarkdown([report], {
      probedAt: '2026-07-15T00:00:00.000Z',
      host: 'test',
    })
    assert.match(md, /# ACP agent behaviour matrix/)
    assert.match(md, /Write routing/)
    assert.match(md, /fs\/write/)
    assert.match(md, /Fake Agent/)

    const json = buildBehaviorMatrixJson([report], { probedAt: '2026-07-15T00:00:00.000Z' })
    assert.equal(json.generatedBy, 'npm run probe:acp:behavior')
    assert.equal(json.reports.length, 1)
    assert.equal(json.reports[0]?.ok, true)
  })

  it('shows — for failed probes', () => {
    const md = renderBehaviorMatrixMarkdown([
      {
        agentId: 'x',
        title: 'Broken',
        command: 'nope',
        args: [],
        prompt: 'p',
        ok: false,
        error: 'not installed',
      },
    ])
    assert.match(md, /Probe failed/)
    assert.match(md, /—/)
  })
})
