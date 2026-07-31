import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import {
  ACP_MODELS_TTL_MS,
  acpModelsCacheStale,
  formatAcpPackageApproval,
  planAcpAutoSetup,
  requestAcpPackageInstallApproval,
  updateCurrentAcpAgentModels,
  type AcpAutoSetupInput,
  type AcpPackageChange,
} from './acp-auto-setup.ts'
import { setApprovalHandler } from '../approval.ts'
import { listAcpAgents } from './acp-agent-registry.ts'
import { setSetting } from '../storage/settings.ts'

afterEach(async () => {
  setApprovalHandler(null)
  await setSetting('registeredAcpAgents', [])
})

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
    assert.deepEqual(plan.upgrade, [])
    assert.deepEqual(
      plan.register.map((k) => k.id),
      ['claude-agent-acp'],
    )
  })

  it('registers (no install) when the adapter is already installed', () => {
    const plan = planAcpAutoSetup([input(claude, { clientInstalled: true, agentInstalled: true })])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.upgrade, [])
    assert.deepEqual(
      plan.register.map((k) => k.id),
      ['claude-agent-acp'],
    )
  })

  it('upgrades an installed autoInstall adapter that is behind the registry', () => {
    const plan = planAcpAutoSetup([
      input(codex, {
        clientInstalled: true,
        agentInstalled: true,
        configured: true,
        hasModels: true,
        outdated: { installedVersion: '1.1.0', latestVersion: '1.1.7' },
      }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(
      plan.upgrade.map((entry) => ({
        id: entry.known.id,
        from: entry.installedVersion,
        to: entry.latestVersion,
      })),
      [{ id: 'codex', from: '1.1.0', to: '1.1.7' }],
    )
    assert.deepEqual(plan.register, [])
    assert.deepEqual(plan.refreshModels, [])
  })

  it('does not upgrade when the version check is absent or the client gate fails', () => {
    assert.deepEqual(
      planAcpAutoSetup([
        input(codex, { clientInstalled: true, agentInstalled: true, outdated: null }),
      ]).upgrade,
      [],
    )
    assert.deepEqual(
      planAcpAutoSetup([
        input(claude, {
          clientInstalled: false,
          agentInstalled: true,
          outdated: { installedVersion: '0.1.0', latestVersion: '0.2.0' },
        }),
      ]).upgrade,
      [],
    )
  })

  it('does nothing when the gating client is absent', () => {
    const plan = planAcpAutoSetup([
      input(claude, { clientInstalled: false, agentInstalled: false }),
    ])
    assert.deepEqual(plan.install, [])
    assert.deepEqual(plan.upgrade, [])
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
    assert.deepEqual(present.upgrade, [])
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
    assert.deepEqual(plan.upgrade, [])
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

describe('acpModelsCacheStale', () => {
  const now = 1_700_000_000_000
  const agent = (over: Partial<AcpAgentConfig> = {}): AcpAgentConfig => ({
    id: 'claude-agent-acp',
    title: 'Claude',
    command: 'claude-agent-acp',
    availableModels: [{ value: 'opus', label: 'Opus' }],
    enabled: true,
    ...over,
  })

  it('treats a cache with no timestamp as stale (written before the field existed)', () => {
    assert.equal(acpModelsCacheStale(agent(), now), true)
  })

  it('is fresh within the TTL and stale once past it', () => {
    assert.equal(acpModelsCacheStale(agent({ modelsProbedAt: now - 1000 }), now), false)
    assert.equal(
      acpModelsCacheStale(agent({ modelsProbedAt: now - ACP_MODELS_TTL_MS - 1 }), now),
      true,
    )
  })

  it('is stale exactly at the TTL boundary', () => {
    assert.equal(acpModelsCacheStale(agent({ modelsProbedAt: now - ACP_MODELS_TTL_MS }), now), true)
  })

  it('never revalidates a disabled agent or one with no cached models', () => {
    assert.equal(acpModelsCacheStale(agent({ enabled: false }), now), false)
    assert.equal(acpModelsCacheStale(agent({ availableModels: [] }), now), false)
    const { availableModels: _omit, ...noModels } = agent()
    assert.equal(acpModelsCacheStale(noModels, now), false)
  })
})

describe('ACP package install approval', () => {
  it('requires explicit approval and names every global package', async () => {
    let body = ''
    let title = ''
    setApprovalHandler(async (request) => {
      title = request.title
      body = request.body
      return { approved: false, remember: false }
    })
    const changes: AcpPackageChange[] = [
      { agent: codex, action: 'install' },
      { agent: claude, action: 'install' },
    ]
    assert.equal(await requestAcpPackageInstallApproval(changes), false)
    assert.equal(title, 'Install ACP adapters globally?')
    assert.match(body, /@agentclientprotocol\/codex-acp/)
    assert.match(body, /@agentclientprotocol\/claude-agent-acp/)
    assert.match(body, /Socket Firewall \(sfw\).*first install it globally/)
    assert.match(body, /lifecycle scripts disabled/)
  })

  it('describes upgrades with from→to versions', () => {
    const { title, body } = formatAcpPackageApproval([
      {
        agent: codex,
        action: 'upgrade',
        fromVersion: '1.1.0',
        toVersion: '1.1.7',
      },
    ])
    assert.equal(title, 'Update ACP adapters globally?')
    assert.match(body, /@agentclientprotocol\/codex-acp \(1\.1\.0 → 1\.1\.7\)/)
    assert.match(body, /Socket Firewall \(sfw\)/)
  })

  it('uses a combined title when installing and upgrading together', () => {
    const { title, body } = formatAcpPackageApproval([
      { agent: claude, action: 'install' },
      {
        agent: codex,
        action: 'upgrade',
        fromVersion: '1.1.0',
        toVersion: '1.1.7',
      },
    ])
    assert.equal(title, 'Install or update ACP adapters?')
    assert.match(body, /claude-agent-acp \(new install\)/)
    assert.match(body, /codex-acp \(1\.1\.0 → 1\.1\.7\)/)
  })
})

describe('updateCurrentAcpAgentModels', () => {
  it('merges models onto the latest registry config after asynchronous work', async () => {
    await setSetting('registeredAcpAgents', [
      {
        id: 'claude-agent-acp',
        title: 'User renamed Claude',
        command: 'custom-claude-acp',
        env: { CLAUDE_CONFIG_DIR: '/custom' },
        enabled: false,
      },
    ])

    const updated = await updateCurrentAcpAgentModels('claude-agent-acp', [
      { value: 'sonnet', label: 'Sonnet' },
    ])

    assert.equal(updated, true)
    assert.deepEqual(listAcpAgents(), [
      {
        id: 'claude-agent-acp',
        title: 'User renamed Claude',
        command: 'custom-claude-acp',
        env: { CLAUDE_CONFIG_DIR: '/custom' },
        availableModels: [{ value: 'sonnet', label: 'Sonnet' }],
        enabled: false,
      },
    ])
  })
})
