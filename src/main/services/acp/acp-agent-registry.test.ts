import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { KNOWN_ACP_AGENTS, RETIRED_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import {
  getAcpAgent,
  listAcpAgents,
  listEnabledAcpAgents,
  resolveAcpPermissionMode,
  resolveAcpSandbox,
  upsertAcpAgent,
} from './acp-agent-registry.ts'

describe('acp agent registry', () => {
  beforeEach(async () => {
    await setSetting('registeredAcpAgents', [])
  })

  it('lists configured agents and offers only the enabled ones', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'gemini', title: 'Gemini CLI', command: 'gemini', enabled: true },
      { id: 'old', title: 'Old Agent', command: 'old', enabled: false },
    ])

    assert.equal(listAcpAgents().length, 2)
    assert.deepEqual(
      listEnabledAcpAgents().map((agent) => agent.id),
      ['gemini'],
    )
  })

  it('resolves an enabled agent by id and fails closed otherwise', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'gemini', title: 'Gemini CLI', command: 'gemini', args: ['--acp'], enabled: true },
      { id: 'disabled', title: 'Disabled', command: 'x', enabled: false },
    ])

    assert.deepEqual(getAcpAgent('gemini')?.args, ['--acp'])
    assert.equal(getAcpAgent('disabled'), null) // disabled → not spawnable
    assert.equal(getAcpAgent('missing'), null)
  })

  it('returns an empty list when nothing is configured', () => {
    assert.deepEqual(listAcpAgents(), [])
    assert.deepEqual(listEnabledAcpAgents(), [])
    assert.equal(getAcpAgent('anything'), null)
  })

  it('keeps different agents registered when two registrations overlap', async () => {
    await setSetting('registeredAcpAgents', [])

    await Promise.all([
      upsertAcpAgent({ id: 'first', title: 'First', command: 'first', enabled: true }),
      upsertAcpAgent({ id: 'second', title: 'Second', command: 'second', enabled: true }),
    ])

    assert.deepEqual(
      listAcpAgents().map((agent) => agent.id),
      ['first', 'second'],
    )
  })

  it('reads inside the settings queue for its own key, not a private one', async () => {
    // A private queue cannot see any other writer of `registeredAcpAgents`, so
    // the read has to sit on `settings:<key>` alongside every other write to it.
    await setSetting('registeredAcpAgents', [])

    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    void runSerialized('settings:registeredAcpAgents', () => blocked)

    let settled = false
    const registering = upsertAcpAgent({
      id: 'first',
      title: 'First',
      command: 'first',
      enabled: true,
    }).then(() => {
      settled = true
    })
    for (let i = 0; i < 15; i++) await new Promise((resolve) => setTimeout(resolve, 1))

    assert.equal(settled, false, 'the registration must wait behind the queued settings write')

    release()
    await registering
    assert.deepEqual(
      listAcpAgents().map((agent) => agent.id),
      ['first'],
    )
  })
})

describe('resolveAcpSandbox (issue #590)', () => {
  const base = { title: 'X', command: 'x', enabled: true }

  it('falls back to the KNOWN_ACP_AGENTS catalog preset for the id', () => {
    const resolved = resolveAcpSandbox({ ...base, id: 'claude-agent-acp' })
    assert.ok(resolved)
    // ASRT wildcards match subdomains only, so the apex is listed alongside;
    // auth endpoints move between subdomains (console/claude.ai), hence the
    // vendor-wide allowlist rather than pinned hosts (#604 validation).
    assert.ok(resolved.allowedDomains.includes('*.anthropic.com'))
    assert.ok(resolved.allowedDomains.includes('anthropic.com'))
    assert.ok(resolved.homeDirs?.includes('.claude'))
  })

  it('prefers an explicit per-config override to the catalog preset', () => {
    const custom = { allowedDomains: ['example.com'] }
    assert.deepEqual(
      resolveAcpSandbox({ ...base, id: 'claude-agent-acp', sandbox: custom }),
      custom,
    )
  })

  it('honors sandbox: false as an explicit opt-out', () => {
    assert.equal(resolveAcpSandbox({ ...base, id: 'claude-agent-acp', sandbox: false }), undefined)
  })

  it('leaves agents with no catalog preset unsandboxed', () => {
    assert.equal(resolveAcpSandbox({ ...base, id: 'my-custom-agent' }), undefined)
  })

  it('falls back to the Cursor catalog sandbox preset', () => {
    const resolved = resolveAcpSandbox({ ...base, id: 'cursor' })
    assert.ok(resolved)
    assert.ok(resolved.allowedDomains.includes('*.cursor.sh'))
    assert.ok(resolved.homeDirs?.includes('.cursor'))
    assert.deepEqual(resolved.scratchPaths, ['/tmp/.cursor'])
  })
})

describe('retired agents keep their confinement', () => {
  const base = { title: 'X', command: 'x', enabled: true }

  it('still resolves the seatbelt for a config naming a retired agent', () => {
    // Withdrawing an agent must never relax it. `resolveAcpSandbox` reads the
    // catalog at spawn time, so an entry that simply vanished would downgrade
    // an existing user's agent to spawning unconfined.
    const resolved = resolveAcpSandbox({ ...base, id: 'claude-code-acp' })
    assert.ok(resolved, 'retired agent resolved no sandbox — it would spawn unconfined')
    assert.ok(resolved.allowedDomains.includes('*.anthropic.com'))
    assert.ok(resolved.homeDirs?.includes('.claude'))
  })

  it('is not offered for install or registration', () => {
    assert.equal(
      KNOWN_ACP_AGENTS.some((agent) => agent.id === 'claude-code-acp'),
      false,
    )
    const retired = RETIRED_ACP_AGENTS.find((agent) => agent.id === 'claude-code-acp')
    assert.ok(retired)
    assert.equal(retired.installPackage, undefined)
    assert.equal(retired.autoInstall, undefined)
    assert.equal(retired.preset, undefined)
  })
})

describe('resolveAcpPermissionMode (issue #607)', () => {
  const base = { title: 'X', command: 'x', enabled: true }

  it('prefers the user-set permissionMode regardless of sandbox state', () => {
    const config = { ...base, id: 'claude-agent-acp', permissionMode: 'plan' }
    assert.equal(resolveAcpPermissionMode(config, true), 'plan')
    assert.equal(resolveAcpPermissionMode(config, false), 'plan')
  })

  it('defaults a sandboxed Claude preset to acceptEdits when none is set', () => {
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'claude-agent-acp' }, true), 'acceptEdits')
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'claude-code-acp' }, true), 'acceptEdits')
  })

  it('leaves an unsandboxed Claude preset on the agent default', () => {
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'claude-agent-acp' }, false), undefined)
  })

  it('uses the Cursor sandbox default and leaves Gemini/custom agents alone', () => {
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'gemini-cli' }, true), undefined)
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'cursor' }, true), 'acceptEdits')
    assert.equal(resolveAcpPermissionMode({ ...base, id: 'my-custom-agent' }, true), undefined)
  })
})

describe('renamed agent ids', () => {
  it('reads a config written under the old id as the current one', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'codex', title: 'Codex', command: 'codex-acp', enabled: true },
    ])
    assert.deepEqual(
      listAcpAgents().map((agent) => agent.id),
      ['codex-acp'],
    )
    // A thread that ran before the rename still names the agent the old way.
    assert.ok(getAcpAgent('codex'))
    assert.ok(getAcpAgent('codex-acp'))
  })

  it('still resolves the seatbelt for a config written under the old id', () => {
    const resolved = resolveAcpSandbox({
      id: 'gemini-cli',
      title: 'Gemini',
      command: 'gemini',
      enabled: true,
    })
    assert.ok(resolved, 'a pre-rename config resolved no sandbox')
    assert.ok(resolved.allowedDomains.includes('*.googleapis.com'))
  })
})
