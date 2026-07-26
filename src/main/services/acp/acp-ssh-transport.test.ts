import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { acpSshTarget, buildRemoteAcpCommand, isAcpOverSshEnabled } from './acp-ssh-transport.ts'

const REMOTE_ROOT = '/remote/project'

async function setUpSshWorkspace(): Promise<void> {
  await setSetting('sshWorkspaceEnabled', true)
  await setSetting('sshWorkspaceHosts', [
    { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
  ])
  storageSet('activeProjectId', 'p1')
  storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
  setWorkspaceRootForTest(REMOTE_ROOT)
}

describe('acpSshTarget gating', () => {
  beforeEach(async () => {
    await setUpSshWorkspace()
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('returns null when the ACP-over-SSH opt-in is off, even on an SSH workspace', async () => {
    await setSetting('acpOverSshEnabled', false)
    assert.equal(isAcpOverSshEnabled(), false)
    assert.equal(acpSshTarget(REMOTE_ROOT), null)
  })

  it('resolves the remote host + root when the opt-in is on', async () => {
    await setSetting('acpOverSshEnabled', true)
    assert.deepEqual(acpSshTarget(REMOTE_ROOT), { hostId: 'dev', remoteRoot: REMOTE_ROOT })
  })

  it('returns null for a local (non-SSH) cwd even with the opt-in on', async () => {
    await setSetting('acpOverSshEnabled', true)
    assert.equal(acpSshTarget('/some/local/path'), null)
  })

  it('returns null when SSH workspaces themselves are disabled', async () => {
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceEnabled', false)
    // Fails closed: no remote target without the underlying SSH workspace feature.
    assert.equal(acpSshTarget(REMOTE_ROOT), null)
  })
})

describe('buildRemoteAcpCommand', () => {
  it('wraps the agent in cd + setsid + exec on the remote root', () => {
    const cmd = buildRemoteAcpCommand({ command: 'claude-code-acp', cwd: REMOTE_ROOT }, REMOTE_ROOT)
    assert.match(cmd, /^cd '\/remote\/project' && setsid sh -c /)
    // The agent replaces the wrapper shell (clean signals + accurate PGID). The
    // command is posix-quoted; a locale/env prefix may sit between exec and it.
    assert.match(cmd, /exec .*'claude-code-acp'/)
    // The PGID marker is printed before the agent so the remote group is killable.
    assert.match(cmd, /__COPSE_PGID__=/)
  })

  it('posix-quotes the command and arguments', () => {
    const cmd = buildRemoteAcpCommand(
      { command: 'my agent', args: ['--flag', 'a b'], cwd: REMOTE_ROOT },
      REMOTE_ROOT,
    )
    assert.ok(cmd.includes("'my agent'"), 'command with a space is quoted')
    assert.ok(cmd.includes("'a b'"), 'argument with a space is quoted')
  })

  it('never forwards local provider secrets to the remote agent', () => {
    const secret = 'sk-should-never-appear'
    const prior = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = secret
    try {
      const cmd = buildRemoteAcpCommand(
        { command: 'claude-code-acp', cwd: REMOTE_ROOT },
        REMOTE_ROOT,
      )
      assert.ok(!cmd.includes(secret), 'the remote command must not contain local API keys')
      assert.ok(!cmd.includes('ANTHROPIC_API_KEY'), 'no provider key names leak either')
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prior
    }
  })
})
