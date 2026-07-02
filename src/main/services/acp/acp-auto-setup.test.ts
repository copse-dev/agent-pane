import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { KnownAcpAgent } from '@shared/acp-known-agents.ts'
import { planAcpAutoSetup, sandboxRetrofits, type AcpAutoSetupInput } from './acp-auto-setup.ts'

const claude: KnownAcpAgent = {
  id: 'claude-agent-acp',
  title: 'Claude',
  command: 'claude-agent-acp',
  args: [],
  installPackage: '@agentclientprotocol/claude-agent-acp',
  requiresClient: 'claude',
  autoInstall: true,
  preset: true,
}
const cursor: KnownAcpAgent = {
  id: 'cursor',
  title: 'Cursor',
  command: 'cursor-agent',
  args: ['acp'],
  requiresClient: 'cursor-agent',
  preset: true,
}
const nonPreset: KnownAcpAgent = {
  id: 'gemini-cli',
  title: 'Gemini CLI',
  command: 'gemini',
  args: ['--experimental-acp'],
}

const input = (known: KnownAcpAgent, over: Partial<AcpAutoSetupInput> = {}): AcpAutoSetupInput => ({
  known,
  agentInstalled: false,
  clientInstalled: false,
  configured: false,
  ...over,
})

describe('planAcpAutoSetup', () => {
  it('installs + registers a preset whose client is present but adapter is missing', () => {
    const plan = planAcpAutoSetup([input(claude, { clientInstalled: true, agentInstalled: false })])
    assert.deepEqual(
      plan.install.map((k) => k.id),
      ['claude-agent-acp'],
    )
    assert.deepEqual(
      plan.register.map((k) => k.id),
      ['claude-agent-acp'],
    )
  })

  it('registers (no install) when the adapter is already installed', () => {
    const plan = planAcpAutoSetup([input(claude, { clientInstalled: true, agentInstalled: true })])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(
      plan.register.map((k) => k.id),
      ['claude-agent-acp'],
    )
  })

  it('does nothing when the gating client is absent', () => {
    const plan = planAcpAutoSetup([
      input(claude, { clientInstalled: false, agentInstalled: false }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.register, [])
  })

  it('never installs a non-npm preset (Cursor); registers only when its binary exists', () => {
    const present = planAcpAutoSetup([
      input(cursor, { clientInstalled: true, agentInstalled: true }),
    ])
    assert.deepEqual(present.install, [])
    assert.deepEqual(
      present.register.map((k) => k.id),
      ['cursor'],
    )

    const absent = planAcpAutoSetup([
      input(cursor, { clientInstalled: false, agentInstalled: false }),
    ])
    assert.deepEqual(absent.install, [])
    assert.deepEqual(absent.register, [])
  })

  it('skips already-configured presets and ignores non-preset agents', () => {
    const plan = planAcpAutoSetup([
      input(claude, { clientInstalled: true, agentInstalled: true, configured: true }),
      input(nonPreset, { clientInstalled: true, agentInstalled: true }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.register, [])
  })
})

describe('sandboxRetrofits (issue #590 adoption)', () => {
  const sandbox = { allowedDomains: ['api.anthropic.com'], homeDirs: ['.claude'] }
  const knownWithSandbox: KnownAcpAgent = { ...claude, sandbox }

  it('patches a pre-#590 config missing the preset sandbox block', () => {
    const existing = [
      { id: 'claude-agent-acp', title: 'Claude', command: 'claude-agent-acp', enabled: true },
    ]
    const retrofits = sandboxRetrofits(existing, [knownWithSandbox, cursor])
    assert.equal(retrofits.length, 1)
    const patched = retrofits[0]
    assert.ok(patched)
    assert.deepEqual(patched.sandbox, sandbox)
    assert.equal(patched.enabled, true)
  })

  it('leaves configs that already carry a sandbox, or match no sandboxed preset, alone', () => {
    const own = { allowedDomains: ['example.com'] }
    const existing = [
      // User already tuned their sandbox — never overridden.
      {
        id: 'claude-agent-acp',
        title: 'Claude',
        command: 'claude-agent-acp',
        sandbox: own,
        enabled: true,
      },
      // Preset without a sandbox block (cursor) and a custom agent: untouched.
      { id: 'cursor', title: 'Cursor', command: 'cursor-agent', enabled: true },
      { id: 'my-agent', title: 'Mine', command: 'mine', enabled: true },
    ]
    assert.deepEqual(sandboxRetrofits(existing, [knownWithSandbox, cursor]), [])
  })
})
