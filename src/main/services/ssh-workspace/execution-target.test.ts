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
import {
  mergeRemoteEnv,
  remoteEnvAllowList,
  remotePtyEnv,
  resolveRemoteLoginShell,
  REMOTE_PGID_PREFIX,
} from './remote-env.ts'

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
  it('includes locale/term vars but not host-local PATH/SHELL or API keys', () => {
    const env = remoteEnvAllowList({
      PATH: '/bin',
      SHELL: '/bin/zsh',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ANTHROPIC_API_KEY: 'secret',
    })
    assert.equal(env['PATH'], undefined)
    assert.equal(env['SHELL'], undefined)
    assert.equal(env['HOME'], undefined)
    assert.equal(env['LANG'], 'en_US.UTF-8')
    assert.equal(env['TERM'], 'xterm-256color')
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

describe('resolveRemoteLoginShell', () => {
  it('uses probed absolute shells and falls back to /bin/bash', () => {
    assert.equal(resolveRemoteLoginShell('/bin/bash'), '/bin/bash')
    assert.equal(resolveRemoteLoginShell('/usr/bin/zsh'), '/usr/bin/zsh')
    assert.equal(resolveRemoteLoginShell(null), '/bin/bash')
    assert.equal(resolveRemoteLoginShell(''), '/bin/bash')
    assert.equal(resolveRemoteLoginShell('bash'), '/bin/bash')
    assert.equal(resolveRemoteLoginShell('/bin/bad shell'), '/bin/bash')
  })
})

describe('remotePtyEnv', () => {
  it('keeps terminal locale keys and drops local PATH/HOME/SHELL', () => {
    const env = remotePtyEnv({
      PATH: '/opt/homebrew/bin:/bin',
      HOME: '/Users/me',
      SHELL: '/bin/zsh',
      LANG: 'C.UTF-8',
      TERM: 'xterm-ghostty',
      COLORTERM: 'truecolor',
      ANTHROPIC_API_KEY: 'secret',
    })
    assert.equal(env['PATH'], undefined)
    assert.equal(env['HOME'], undefined)
    assert.equal(env['SHELL'], undefined)
    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
    assert.equal(env['LANG'], 'C.UTF-8')
    assert.equal(env['TERM'], 'xterm-ghostty')
    assert.equal(env['COLORTERM'], 'truecolor')
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

  it('uses project.path as remoteRoot even when workspace root differs', () => {
    setWorkspaceRootForTest('/remote/other')
    assert.deepEqual(getActiveExecutionTarget(), {
      kind: 'ssh',
      hostId: 'dev',
      remoteRoot: '/remote/project',
    })
  })

  it('still returns ssh when workspace root is unset but the active project is remote', () => {
    setWorkspaceRootForTest(null)
    assert.deepEqual(getActiveExecutionTarget(), {
      kind: 'ssh',
      hostId: 'dev',
      remoteRoot: '/remote/project',
    })
  })

  it('recovers ssh host from workspace root when activeProjectId lacks sshHost', () => {
    storageSet('activeProjectId', 'stale')
    storageSet('projects', [
      { id: 'stale', path: '/local/old', name: 'Old' },
      { id: 'p1', path: '/etc/ddg', name: 'ddg', sshHost: 'dev' },
    ])
    setWorkspaceRootForTest('/etc/ddg')
    assert.deepEqual(getActiveExecutionTarget(), {
      kind: 'ssh',
      hostId: 'dev',
      remoteRoot: '/etc/ddg',
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
