import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from './connection-manager.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'
import { buildRemotePtyLaunch } from './ssh-spawn.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

const TEST_HOST: SshWorkspaceHost = {
  id: 'dev-box',
  label: 'Dev box',
  host: 'dev.example.com',
  user: 'alice',
}

async function withTestHost(run: () => Promise<void>): Promise<void> {
  const previous = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
  await setSetting('sshWorkspaceHosts', [TEST_HOST])
  try {
    await run()
  } finally {
    await setSetting('sshWorkspaceHosts', previous)
  }
}

describe('buildRemotePtyLaunch', () => {
  beforeEach(() => {
    resetSshConnectionManagerForTests()
  })

  afterEach(() => {
    resetSshConnectionManagerForTests()
  })

  it('execs the probed remote shell and does not forward local SHELL/PATH', async () => {
    await withTestHost(async () => {
      setSshTransportFactory(
        () =>
          new FakeSshTransport([
            { when: /^uname -s$/, stdout: 'Linux\n' },
            { when: /^uname -m$/, stdout: 'x86_64\n' },
            { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
            { when: /command -v git$/, stdout: '/usr/bin/git\n' },
            { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
            { when: /command -v inotifywait$/, stdout: '', code: 1 },
          ]),
      )

      await getSshConnectionManager().connect('dev-box')
      const launch = await buildRemotePtyLaunch('dev-box', '/etc/ddg', {
        SHELL: '/bin/zsh',
        PATH: '/opt/homebrew/bin:/bin',
        HOME: '/Users/me',
        LANG: 'en_US.UTF-8',
      })

      const remoteCmd = launch.args.at(-1)
      assert.ok(remoteCmd)
      assert.match(remoteCmd, /cd '\/etc\/ddg'/)
      assert.match(remoteCmd, /exec '\/bin\/bash' -l/)
      assert.doesNotMatch(remoteCmd, /\/bin\/zsh/)
      assert.doesNotMatch(remoteCmd, /PATH=/)
      assert.doesNotMatch(remoteCmd, /HOME=/)
      assert.doesNotMatch(remoteCmd, /SHELL=/)
      assert.match(remoteCmd, /LANG='en_US\.UTF-8'/)
      assert.equal(launch.file, 'ssh')
      assert.equal(launch.args[0], '-tt')
      launch.release()
    })
  })

  it('falls back to /bin/bash when the probe has no shell', async () => {
    await withTestHost(async () => {
      setSshTransportFactory(
        () =>
          new FakeSshTransport([
            { when: /^uname -s$/, stdout: 'Linux\n' },
            { when: /^uname -m$/, stdout: 'x86_64\n' },
            { when: /printf %s "\$SHELL"/, stdout: '', code: 1 },
            { when: /command -v git$/, stdout: '/usr/bin/git\n' },
            { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
            { when: /command -v inotifywait$/, stdout: '/usr/bin/inotifywait\n' },
          ]),
      )

      await getSshConnectionManager().connect('dev-box')
      const launch = await buildRemotePtyLaunch('dev-box', '/home/alice/proj')
      const remoteCmd = launch.args.at(-1)
      assert.ok(remoteCmd)
      assert.match(remoteCmd, /exec '\/bin\/bash' -l/)
      launch.release()
    })
  })
})
