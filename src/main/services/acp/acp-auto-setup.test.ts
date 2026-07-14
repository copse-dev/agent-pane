import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { KnownAcpAgent } from '@shared/acp-known-agents.ts'
import {
  planAcpAutoSetup,
  planAcpPackageUpdates,
  type AcpAutoSetupInput,
} from './acp-auto-setup.ts'

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
const codex: KnownAcpAgent = {
  id: 'codex',
  title: 'Codex',
  command: 'codex-acp',
  args: [],
  installPackage: '@agentclientprotocol/codex-acp',
  autoInstall: true,
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
  hasModels: false,
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

  it('installs + registers a standalone npm preset with no gating client', () => {
    const plan = planAcpAutoSetup([input(codex, { clientInstalled: true, agentInstalled: false })])
    assert.deepEqual(
      plan.install.map((k) => k.id),
      ['codex'],
    )
    assert.deepEqual(
      plan.register.map((k) => k.id),
      ['codex'],
    )
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

  it('skips already-configured presets that already have models, ignores non-presets', () => {
    const plan = planAcpAutoSetup([
      input(claude, {
        clientInstalled: true,
        agentInstalled: true,
        configured: true,
        hasModels: true,
      }),
      input(nonPreset, { clientInstalled: true, agentInstalled: true }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.register, [])
    assert.deepEqual(plan.refreshModels, [])
  })

  it('re-probes a configured, installed preset that still has no cached models', () => {
    const plan = planAcpAutoSetup([
      input(claude, {
        clientInstalled: true,
        agentInstalled: true,
        configured: true,
        hasModels: false,
      }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.register, [])
    assert.deepEqual(
      plan.refreshModels.map((k) => k.id),
      ['claude-agent-acp'],
    )
  })

  it('does not re-probe when the configured preset binary is missing', () => {
    const plan = planAcpAutoSetup([
      input(claude, { configured: true, agentInstalled: false, hasModels: false }),
    ])
    assert.deepEqual(plan.refreshModels, [])
  })
})

describe('planAcpPackageUpdates', () => {
  it('refreshes installed auto-managed npm presets', () => {
    const plan = planAcpPackageUpdates([
      input(codex, { agentInstalled: true }),
      input(claude, { agentInstalled: true, clientInstalled: false }),
    ])
    assert.deepEqual(
      plan.map((k) => k.id),
      ['codex', 'claude-agent-acp'],
    )
  })

  it('skips missing, non-auto, and non-preset agents', () => {
    const plan = planAcpPackageUpdates([
      input(codex, { agentInstalled: false }),
      input(cursor, { agentInstalled: true, clientInstalled: true }),
      input(nonPreset, { agentInstalled: true, clientInstalled: true }),
    ])
    assert.deepEqual(plan, [])
  })
})
