import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { storageSet } from '../storage/storage.ts'
import {
  getActiveExecutionTarget,
  isActiveSshWorkspace,
  isSshWorkspaceExecutionEnabled,
} from './execution-target.ts'
import { wrapRemoteShellWithPgid } from './ssh-spawn.ts'
import { remoteEnvAllowList, REMOTE_PGID_PREFIX } from './remote-env.ts'

describe('wrapRemoteShellWithPgid', () => {
  it('wraps with cd, setsid, and pgid marker', () => {
    const cmd = wrapRemoteShellWithPgid('/var/www', 'echo hi')
    assert.match(cmd, /cd '\/var\/www'/)
    assert.match(cmd, /setsid sh -c/)
    assert.match(cmd, new RegExp(REMOTE_PGID_PREFIX))
    assert.match(cmd, /echo hi/)
  })
})

describe('remoteEnvAllowList', () => {
  it('includes PATH but not API keys', () => {
    const env = remoteEnvAllowList({ PATH: '/bin', ANTHROPIC_API_KEY: 'secret' })
    assert.equal(env['PATH'], '/bin')
    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
  })
})

describe('getActiveExecutionTarget', () => {
  beforeEach(async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: '/remote/project', sshHost: 'dev' }])
    setWorkspaceRootForTest('/remote/project')
  })

  afterEach(() => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    void setSetting('sshWorkspaceEnabled', false)
    void setSetting('sshWorkspaceHosts', [])
  })

  it('returns ssh target when enabled and configured', () => {
    assert.equal(isSshWorkspaceExecutionEnabled(), true)
    assert.deepEqual(getActiveExecutionTarget(), {
      kind: 'ssh',
      hostId: 'dev',
      remoteRoot: '/remote/project',
    })
  })

  it('returns local when execution is disabled', async () => {
    await setSetting('sshWorkspaceEnabled', false)
    assert.deepEqual(getActiveExecutionTarget(), { kind: 'local' })
  })

  it('isActiveSshWorkspace reflects enabled ssh project', () => {
    assert.equal(isActiveSshWorkspace(), true)
  })
})
