import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  gateRemoteAcpEnvForward,
  remoteAcpAuthRequiredHint,
  resetRemoteAcpEnvDecisionsForTests,
} from './acp-remote-env-gate.ts'

const REMOTE_ROOT = '/remote/project'

// The SSH-target + env path is deliberately untested here: it opens the real
// approval dialog, which needs a window. Its fail-closed shape (no dialog →
// env deleted) is enforced by gateRemoteAcpEnvForward's `.catch(() => false)`.
describe('gateRemoteAcpEnvForward (paths that never prompt)', () => {
  beforeEach(async () => {
    resetRemoteAcpEnvDecisionsForTests()
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
    setWorkspaceRootForTest(REMOTE_ROOT)
  })

  afterEach(async () => {
    resetRemoteAcpEnvDecisionsForTests()
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('passes an env-less config through untouched, even for an SSH target', async () => {
    const config = { command: 'claude-code-acp', cwd: REMOTE_ROOT }
    assert.equal(await gateRemoteAcpEnvForward('claude-acp', config), config)
    assert.ok(!('env' in config))
  })

  it('keeps env intact for a local cwd — nothing crosses a wire, no consent needed', async () => {
    const config = {
      command: 'claude-code-acp',
      cwd: '/some/local/path',
      env: { ANTHROPIC_API_KEY: 'sk-local' },
    }
    await gateRemoteAcpEnvForward('claude-acp', config)
    assert.deepEqual(config.env, { ANTHROPIC_API_KEY: 'sk-local' })
  })
})

describe('remoteAcpAuthRequiredHint', () => {
  beforeEach(async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
    setWorkspaceRootForTest(REMOTE_ROOT)
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('rewrites a remote "Authentication required" into remote-side remedies', () => {
    const err = new Error('Authentication required')
    const hint = remoteAcpAuthRequiredHint(err, REMOTE_ROOT, 'claude-acp')
    assert.ok(hint)
    assert.match(hint.message, /dev/)
    assert.match(hint.message, /Settings → ACP agents/)
    assert.equal(hint.cause, err)
  })

  it('matches the agent-reported authentication_failed error kind too', () => {
    const err = new Error('ACP error -32603: Internal error {"errorKind":"authentication_failed"}')
    assert.ok(remoteAcpAuthRequiredHint(err, REMOTE_ROOT, 'claude-acp'))
  })

  it('leaves local auth failures alone — the default message is right there', () => {
    const err = new Error('Authentication required')
    assert.equal(remoteAcpAuthRequiredHint(err, '/some/local/path', 'claude-acp'), null)
  })

  it('leaves non-auth failures alone', () => {
    assert.equal(remoteAcpAuthRequiredHint(new Error('boom'), REMOTE_ROOT, 'claude-acp'), null)
  })
})
