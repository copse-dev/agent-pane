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
import { mergeRemoteEnv, remoteEnvAllowList, REMOTE_PGID_PREFIX } from './remote-env.ts'

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

  it('forwards only explicit Git backup variables, never arbitrary caller environment', () => {
    const env = mergeRemoteEnv({
      GIT_INDEX_FILE: '/tmp/copse-backup.index',
      GIT_AUTHOR_NAME: 'Copse',
      GIT_AUTHOR_EMAIL: 'copse@localhost',
      GIT_COMMITTER_NAME: 'Copse',
      GIT_COMMITTER_EMAIL: 'copse@localhost',
      ANTHROPIC_API_KEY: 'secret',
      CUSTOM_SECRET: 'secret',
    })
    assert.equal(env['GIT_INDEX_FILE'], '/tmp/copse-backup.index')
    assert.equal(env['GIT_AUTHOR_NAME'], 'Copse')
    assert.equal(env['GIT_AUTHOR_EMAIL'], 'copse@localhost')
    assert.equal(env['GIT_COMMITTER_NAME'], 'Copse')
    assert.equal(env['GIT_COMMITTER_EMAIL'], 'copse@localhost')
    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
    assert.equal(env['CUSTOM_SECRET'], undefined)
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

  it('returns local when execution is disabled for a local project', async () => {
    await setSetting('sshWorkspaceEnabled', false)
    storageSet('projects', [{ id: 'p1', path: '/local/project' }])
    setWorkspaceRootForTest('/local/project')
    assert.deepEqual(getActiveExecutionTarget(), { kind: 'local' })
  })

  it('throws when execution is disabled for a remote project', async () => {
    await setSetting('sshWorkspaceEnabled', false)
    assert.throws(() => getActiveExecutionTarget(), /SSH workspaces are disabled/)
  })

  it('throws when the remote host is not configured', async () => {
    storageSet('projects', [{ id: 'p1', path: '/remote/project', sshHost: 'missing' }])
    assert.throws(() => getActiveExecutionTarget(), /not configured/)
  })

  it('isActiveSshWorkspace reflects enabled ssh project', () => {
    assert.equal(isActiveSshWorkspace(), true)
  })
})
