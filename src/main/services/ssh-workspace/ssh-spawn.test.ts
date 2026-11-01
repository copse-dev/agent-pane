import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from './connection-manager.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'
import { REMOTE_PGID_PREFIX } from './remote-env.ts'
import { takeRemoteProcessMeta } from './remote-process-meta.ts'
import { buildRemotePtyLaunch, spawnRemoteShellCommand } from './ssh-spawn.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { setSshControlDirForTests } from './ssh-paths.ts'
import { shortSocketDirectory } from '../../../../tests/helpers/short-socket-directory.ts'

beforeEach((t) => {
  setSshControlDirForTests(shortSocketDirectory(t))
})

afterEach(() => {
  setSshControlDirForTests(null)
})

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
          ]),
      )

      await getSshConnectionManager().connect('dev-box')
      const launch = await buildRemotePtyLaunch('dev-box', '/srv/app', {
        SHELL: '/bin/zsh',
        PATH: '/opt/homebrew/bin:/bin',
        HOME: '/Users/me',
        LANG: 'en_US.UTF-8',
      })

      const remoteCmd = launch.args.at(-1)
      assert.ok(remoteCmd)
      assert.match(remoteCmd, /cd '\/srv\/app'/)
      assert.match(remoteCmd, /LANG='en_US\.UTF-8' exec '\/bin\/bash' -l/)
      assert.doesNotMatch(remoteCmd, /\benv\b/)
      assert.doesNotMatch(remoteCmd, /\/bin\/zsh/)
      assert.doesNotMatch(remoteCmd, /PATH=/)
      assert.doesNotMatch(remoteCmd, /HOME=/)
      assert.doesNotMatch(remoteCmd, /SHELL=/)
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

describe('spawnRemoteShellCommand', () => {
  const probes = (): FakeSshTransport =>
    new FakeSshTransport([
      { when: /^uname -s$/, stdout: 'Linux\n' },
      { when: /^uname -m$/, stdout: 'x86_64\n' },
      { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
      { when: /command -v git$/, stdout: '/usr/bin/git\n' },
      { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
    ])
  let binDir: string
  let previousPath: string | undefined

  beforeEach(() => {
    resetSshConnectionManagerForTests()
    // A stand-in `ssh` that answers like the remote PGID wrapper does.
    binDir = mkdtempSync(join(tmpdir(), 'copse-fake-ssh-'))
    const fakeSsh = join(binDir, 'ssh')
    writeFileSync(fakeSsh, `#!/bin/sh\nprintf '${REMOTE_PGID_PREFIX}4242\\nhello\\n'\n`)
    chmodSync(fakeSsh, 0o755)
    previousPath = process.env['PATH']
    process.env['PATH'] = `${binDir}:${previousPath ?? ''}`
  })

  afterEach(() => {
    if (previousPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = previousPath
    rmSync(binDir, { recursive: true, force: true })
    resetSshConnectionManagerForTests()
  })

  it('strips the PGID line when stdin is ignored but stdout is piped', async () => {
    await withTestHost(async () => {
      setSshTransportFactory(probes)
      await getSshConnectionManager().connect('dev-box')
      const proc = await spawnRemoteShellCommand('echo hello', {
        hostId: 'dev-box',
        remoteRoot: '/srv/app',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      await new Promise((resolve) => proc.on('close', resolve))
      assert.equal(output, 'hello\n')
      assert.equal(takeRemoteProcessMeta(proc)?.pgid, 4242)
    })
  })
})
