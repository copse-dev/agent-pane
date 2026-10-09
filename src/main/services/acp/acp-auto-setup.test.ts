import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { KnownAcpAgent } from '@shared/acp-known-agents.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import {
  ACP_MODELS_TTL_MS,
  acpModelsCacheStale,
  formatAcpPackageApproval,
  installAcpPackageChanges,
  planAcpAutoSetup,
  requestAcpPackageInstallApproval,
  runAcpAutoSetup,
  updateCurrentAcpAgentModels,
  type AcpAutoSetupInput,
  type AcpPackageChange,
} from './acp-auto-setup.ts'
import { setApprovalHandler } from '../approval.ts'
import { listAcpAgents } from './acp-agent-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { storageSet } from '../storage/storage.ts'

afterEach(async () => {
  setApprovalHandler(null)
  await setSetting('registeredAcpAgents', [])
})

describe('runAcpAutoSetup on an SSH workspace', () => {
  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
  })

  it('is a no-op: never detects, installs, or registers anything', async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: '/remote/project', sshHost: 'dev' }])
    setWorkspaceRootForTest('/remote/project')

    setApprovalHandler(async () => {
      assert.fail('an SSH workspace must never prompt for an ACP package install')
    })

    const result = await runAcpAutoSetup(new AbortController().signal)

    assert.deepEqual(result, {
      installed: [],
      upgraded: [],
      registered: [],
      modelsDetected: [],
      failed: [],
    })
    assert.deepEqual(listAcpAgents(), [])
  })
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
  args: ['--acp'],
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
    let showWhileSettingsOpen = false
    setApprovalHandler(async (request) => {
      title = request.title
      body = request.body
      showWhileSettingsOpen = request.showWhileSettingsOpen === true
      return { approved: false, remember: false }
    })
    const changes: AcpPackageChange[] = [
      { agent: codex, action: 'install' },
      { agent: claude, action: 'install' },
    ]
    assert.equal(await requestAcpPackageInstallApproval(changes), false)
    assert.equal(title, 'Install software to connect your coding agents?')
    assert.match(body, /@agentclientprotocol\/codex-acp/)
    assert.match(body, /@agentclientprotocol\/claude-agent-acp/)
    assert.match(body, /Socket Firewall \(sfw\).*first install it globally/)
    assert.match(body, /lifecycle scripts disabled/)
    assert.equal(showWhileSettingsOpen, true)
  })

  it('updates an already installed adapter without asking for approval', async () => {
    let requests = 0
    setApprovalHandler(async () => {
      requests += 1
      return { approved: false, remember: false }
    })
    assert.equal(
      await requestAcpPackageInstallApproval(
        [
          {
            agent: codex,
            action: 'upgrade',
            fromVersion: '1.1.0',
            toVersion: '1.1.7',
          },
        ],
        true,
      ),
      true,
    )
    assert.equal(requests, 0)
  })

  it('asks only for missing adapters when installs and upgrades coexist with SFW present', async () => {
    let body = ''
    setApprovalHandler(async (request) => {
      body = request.body
      return { approved: false, remember: false }
    })
    const changes: AcpPackageChange[] = [
      { agent: claude, action: 'install' },
      {
        agent: codex,
        action: 'upgrade',
        fromVersion: '1.1.0',
        toVersion: '1.1.7',
      },
    ]
    assert.equal(await requestAcpPackageInstallApproval(changes, true), false)
    assert.match(body, /claude-agent-acp/)
    assert.doesNotMatch(body, /codex-acp/)
    assert.equal(
      formatAcpPackageApproval(changes, true).title,
      'Install software to connect your coding agents?',
    )
  })
})

describe('ACP package mutations and Socket Firewall bootstrap consent', () => {
  const upgrade: AcpPackageChange = {
    agent: codex,
    action: 'upgrade',
    fromVersion: '1.1.0',
    toVersion: '1.1.7',
  }

  for (const approved of [false, true]) {
    it(`discloses every mixed bootstrap mutation and ${approved ? 'runs' : 'blocks'} the disclosed packages`, async () => {
      const installed: string[] = []
      setApprovalHandler(async (request) => {
        assert.match(request.body, /claude-agent-acp/)
        assert.match(request.body, /also update these installed packages/)
        assert.match(request.body, /codex-acp \(1\.1\.0 → 1\.1\.7\)/)
        assert.match(request.body, /first install it globally/)
        return { approved, remember: false }
      })
      const result = await installAcpPackageChanges(
        [{ agent: claude, action: 'install' }, upgrade],
        new AbortController().signal,
        {
          socketFirewallAvailable: () => false,
          requestInstallApproval: requestAcpPackageInstallApproval,
          resolveNpmBin: async () => undefined,
          install: async (pkg) => {
            installed.push(pkg)
            return true
          },
        },
      )
      assert.deepEqual(installed, approved ? [claude.installPackage, codex.installPackage] : [])
      assert.deepEqual(result.installed, approved ? ['claude-agent-acp'] : [])
      assert.deepEqual(result.upgraded, approved ? ['codex'] : [])
      assert.equal(result.failed.length, approved ? 0 : 2)
    })

    it(`requests fresh SFW consent for an upgrade and ${approved ? 'runs' : 'blocks'} all global mutations`, async () => {
      const prompts: string[] = []
      const installed: string[] = []
      setApprovalHandler(async (request) => {
        prompts.push(request.title)
        assert.match(request.body, /install Socket Firewall \(sfw\) globally before updating/)
        assert.match(request.body, /lifecycle scripts disabled/)
        assert.equal(request.allowRemember, false)
        assert.equal(request.showWhileSettingsOpen, true)
        return { approved, remember: false }
      })
      const result = await installAcpPackageChanges([upgrade], new AbortController().signal, {
        socketFirewallAvailable: () => false,
        requestInstallApproval: requestAcpPackageInstallApproval,
        resolveNpmBin: async () => '/existing/node/bin/npm',
        install: async (pkg, _signal, options) => {
          assert.equal(options?.npmBin, '/existing/node/bin/npm')
          installed.push(pkg)
          return true
        },
      })
      assert.deepEqual(prompts, ['Install Socket Firewall globally?'])
      assert.deepEqual(installed, approved ? ['@agentclientprotocol/codex-acp'] : [])
      assert.deepEqual(result.upgraded, approved ? ['codex'] : [])
      assert.equal(result.failed.length, approved ? 0 : 1)
    })
  }

  for (const socketFirewallAvailable of [false, true]) {
    it(`declining a fresh adapter ${socketFirewallAvailable ? 'allows' : 'blocks'} an existing adapter upgrade when SFW is ${socketFirewallAvailable ? 'present' : 'absent'}`, async () => {
      const installed: string[] = []
      setApprovalHandler(async () => ({ approved: false, remember: false }))
      const result = await installAcpPackageChanges(
        [{ agent: claude, action: 'install' }, upgrade],
        new AbortController().signal,
        {
          socketFirewallAvailable: () => socketFirewallAvailable,
          requestInstallApproval: requestAcpPackageInstallApproval,
          resolveNpmBin: async () => undefined,
          install: async (pkg) => {
            installed.push(pkg)
            return true
          },
        },
      )
      assert.deepEqual(installed, socketFirewallAvailable ? ['@agentclientprotocol/codex-acp'] : [])
      assert.deepEqual(result.upgraded, socketFirewallAvailable ? ['codex'] : [])
      assert.equal(result.failed.length, socketFirewallAvailable ? 1 : 2)
    })
  }

  it('does not bootstrap SFW or request approval when there are no package changes', async () => {
    setApprovalHandler(async () => {
      assert.fail('no-op setup must not request installation consent')
    })
    assert.equal(await requestAcpPackageInstallApproval([], false), true)
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
    // The seed uses the pre-rename id on purpose: the merge must find it, and
    // the list must read back canonically (`LEGACY_ACP_AGENT_IDS`).
    assert.deepEqual(listAcpAgents(), [
      {
        id: 'claude-acp',
        title: 'User renamed Claude',
        command: 'custom-claude-acp',
        env: { CLAUDE_CONFIG_DIR: '/custom' },
        availableModels: [{ value: 'sonnet', label: 'Sonnet' }],
        enabled: false,
      },
    ])
  })
})
