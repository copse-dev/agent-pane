import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionRequest,
} from '@agentclientprotocol/sdk'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import {
  acpSessionMeta,
  openAcpSession,
  type AcpAgentSpawnConfig,
  type MutableAcpHandlers,
} from './acp-client.ts'
import { claudeSandboxEscapeSessionMeta } from './acp-claude-sandbox-escape.ts'

const SANDBOX = { allowedDomains: ['api.anthropic.com'] }

/**
 * #4146: a Claude agent under Copse's sandbox gets Claude Code flag settings
 * whose hook refuses `dangerouslyDisableSandbox` with an explanation. Nothing
 * else gets `_meta`: another agent would not read Claude Code settings, and an
 * agent outside Copse's sandbox has a working escape of its own.
 */
describe('ACP session _meta (#4146)', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  function sandboxActive(): void {
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    cleanups.push(() => {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    })
  }

  const posix = process.platform !== 'win32'
  const claude = { command: 'claude-agent-acp', sandbox: SANDBOX }
  const local = { remote: false, bridgeMounted: true }

  it('refuses the escape only for a local Claude agent under the sandbox', { skip: !posix }, () => {
    sandboxActive()
    assert.deepEqual(acpSessionMeta(claude, local), claudeSandboxEscapeSessionMeta(true))
    assert.deepEqual(
      acpSessionMeta({ command: '/opt/homebrew/bin/claude-agent-acp', sandbox: SANDBOX }, local),
      claudeSandboxEscapeSessionMeta(true),
    )
    assert.deepEqual(
      acpSessionMeta(claude, { remote: false, bridgeMounted: false }),
      claudeSandboxEscapeSessionMeta(false),
    )
    assert.equal(acpSessionMeta({ command: 'codex-acp', sandbox: SANDBOX }, local), undefined)
    assert.equal(acpSessionMeta({ command: 'claude-agent-acp' }, local), undefined)
    assert.equal(acpSessionMeta(claude, { remote: true, bridgeMounted: false }), undefined)
    assert.equal(acpSessionMeta({ ...claude, executionMode: 'agent' }, local), undefined)
  })

  it('sends nothing while the project sandbox is off', () => {
    assert.equal(acpSessionMeta(claude, local), undefined)
  })

  async function sessionNewParams(config: AcpAgentSpawnConfig): Promise<NewSessionRequest> {
    let params: NewSessionRequest | null = null
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const connection = agent({ name: 'scripted-meta-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { mcpCapabilities: { http: true } },
      }))
      .onRequest('session/new', (ctx) => {
        params = ctx.params
        return { sessionId: 'meta-session' }
      })
      .connect(ndJsonStream(a2c.writable, c2a.readable))
    const handlers: MutableAcpHandlers = {
      current: {
        onChunk: () => undefined,
        requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      },
    }
    const open = await openAcpSession(config, handlers, () =>
      Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: () => {
          connection.close()
        },
      }),
    )
    cleanups.push(() => open.dispose())
    assert.ok(params, 'the agent should have received session/new')
    return params
  }

  it('puts the refusal hook on the wire with session/new', { skip: !posix }, async () => {
    sandboxActive()
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'copse-acp-meta-')))
    cleanups.push(async () => rm(cwd, { recursive: true, force: true }))
    const bridge = { url: 'http://127.0.0.1:1/mcp', token: 'test-token' }

    const withBridge = await sessionNewParams({
      ...claude,
      cwd,
      sshTarget: null,
      nativeBridge: bridge,
    })
    assert.deepEqual(withBridge._meta, claudeSandboxEscapeSessionMeta(true))
    assert.ok(withBridge.mcpServers.some((server) => server.name === 'copse'))

    const noBridge = await sessionNewParams({ ...claude, cwd, sshTarget: null })
    assert.deepEqual(noBridge._meta, claudeSandboxEscapeSessionMeta(false))

    const codex = await sessionNewParams({
      command: 'codex-acp',
      sandbox: SANDBOX,
      cwd,
      sshTarget: null,
    })
    assert.equal(codex._meta, undefined)
  })
})
