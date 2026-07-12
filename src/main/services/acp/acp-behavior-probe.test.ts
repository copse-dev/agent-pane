import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
} from '@agentclientprotocol/sdk'
import {
  classifyWriteRouting,
  runBehaviorTurn,
  summarizePermissions,
  type AcpBehaviorConfig,
  type AcpBehaviorOptions,
  type AcpBehaviorRun,
} from './acp-behavior-probe.ts'

/**
 * Drive the behavior harness against an in-memory fake agent whose per-turn
 * actions we script, wired through byte pipes (no subprocess). Proves the
 * harness records write routing and permission payloads correctly without any
 * agent installed — the CI-verifiable core of the Tier-2 eval.
 */
type TransportFactory = NonNullable<AcpBehaviorOptions['createTransport']>
type OnPrompt = (peer: AgentContext, sessionId: string) => Promise<void>

const SESSION_ID = 'sess-1'

function fakeAgent(onPrompt: OnPrompt): TransportFactory {
  return (_config: AcpBehaviorConfig) => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentStream = ndJsonStream(a2c.writable, c2a.readable)
    const clientStream = ndJsonStream(c2a.writable, a2c.readable)

    agent({ name: 'fake-agent' })
      .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest('authenticate', () => ({}))
      .onRequest('session/new', () => ({ sessionId: SESSION_ID }))
      .onRequest('session/prompt', async (ctx) => {
        await onPrompt(ctx.client, SESSION_ID)
        return { stopReason: 'end_turn' }
      })
      .onNotification('session/cancel', () => {})
      .connect(agentStream)

    return Promise.resolve({ stream: clientStream, dispose: () => {} })
  }
}

/**
 * Run one scripted turn in a throwaway workspace seeded with `probe.txt`. The
 * prompt builder receives the workspace dir so it can target real paths (the dir
 * is created before the turn and cleaned up after).
 */
async function runInWorkspace(
  makeOnPrompt: (dir: string) => OnPrompt,
  scenarioExtra: { permission?: 'allow' | 'reject' } = {},
): Promise<AcpBehaviorRun> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-behavior-'))
  writeFileSync(join(dir, 'probe.txt'), 'FOO')
  try {
    return await runBehaviorTurn(
      { command: 'fake', cwd: dir },
      { prompt: 'edit probe.txt: FOO -> BAR', watchPaths: ['probe.txt'], ...scenarioExtra },
      { createTransport: fakeAgent(makeOnPrompt(dir)) },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('write routing', () => {
  it('classifies an fs/write_text_file edit as fs_write', async () => {
    const run = await runInWorkspace(
      (dir): OnPrompt =>
        async (peer, sessionId) => {
          await peer.request(methods.client.fs.writeTextFile, {
            sessionId,
            path: join(dir, 'probe.txt'),
            content: 'BAR',
          })
        },
    )
    assert.equal(run.ok, true)
    assert.equal(classifyWriteRouting(run, 'probe.txt'), 'fs_write')
    assert.ok(run.transcript.some((e) => e.type === 'fs_write' && e.path === 'probe.txt'))
  })

  it('classifies a direct on-disk write (shell bypass) as shell_bypass', async () => {
    // The agent writes to the workspace itself, simulating a shell tool that
    // never routes through fs/write_text_file.
    const run = await runInWorkspace(
      (dir): OnPrompt =>
        () => {
          writeFileSync(join(dir, 'probe.txt'), 'BAR')
          return Promise.resolve()
        },
    )
    assert.equal(run.ok, true)
    assert.deepEqual(run.changedPaths, ['probe.txt'])
    assert.equal(classifyWriteRouting(run, 'probe.txt'), 'shell_bypass')
    assert.ok(!run.transcript.some((e) => e.type === 'fs_write'))
  })

  it('classifies a turn that touches nothing as no_write', async () => {
    const run = await runInWorkspace((): OnPrompt => () => Promise.resolve())
    assert.equal(run.ok, true)
    assert.deepEqual(run.changedPaths, [])
    assert.equal(classifyWriteRouting(run, 'probe.txt'), 'no_write')
  })
})

describe('permission payload', () => {
  it('records a permission carrying structured rawInput', async () => {
    const run = await runInWorkspace(
      (): OnPrompt => async (peer, sessionId) => {
        await peer.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: 't1',
            title: 'Run `ls -la`',
            rawInput: { command: 'ls -la' },
            status: 'pending',
          },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        })
      },
    )
    const perms = summarizePermissions(run)
    assert.equal(perms.count, 1)
    assert.equal(perms.anyStructuredInput, true)
    assert.deepEqual(perms.titles, ['Run `ls -la`'])
    assert.equal(perms.subjectPresent, false)
  })

  it('records a title-only permission (no structured input)', async () => {
    const run = await runInWorkspace(
      (): OnPrompt => async (peer, sessionId) => {
        await peer.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: 't1', title: 'Proceed?', status: 'pending' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })
      },
    )
    const perms = summarizePermissions(run)
    assert.equal(perms.count, 1)
    assert.equal(perms.anyStructuredInput, false)
    assert.deepEqual(perms.titles, ['Proceed?'])
  })
})

describe('runBehaviorTurn error handling', () => {
  it('captures a transport failure as ok:false', async () => {
    const run = await runBehaviorTurn(
      { command: 'fake', cwd: tmpdir() },
      { prompt: 'hi' },
      { createTransport: () => Promise.reject(new Error('spawn ENOENT')) },
    )
    assert.equal(run.ok, false)
    assert.match(run.error ?? '', /ENOENT/)
    assert.equal(run.stopReason, null)
  })
})
