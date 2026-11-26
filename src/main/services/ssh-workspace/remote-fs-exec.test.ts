import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from './connection-manager.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'
import { execOnConnectedSshHost, execOnSshHost } from './remote-fs-exec.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

const HOST: SshWorkspaceHost = { id: 'dev-box', label: 'Dev box', host: 'dev.example.com' }

describe('execOnConnectedSshHost', () => {
  let previous: SshWorkspaceHost[] = []
  let connects = 0

  beforeEach(async () => {
    resetSshConnectionManagerForTests()
    previous = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
    await setSetting('sshWorkspaceHosts', [HOST])
    connects = 0
    setSshTransportFactory(
      () =>
        new FakeSshTransport([{ when: /^stat /, stdout: 'ok\n' }], {
          onConnect: (): void => {
            connects += 1
          },
        }),
    )
  })

  afterEach(async () => {
    resetSshConnectionManagerForTests()
    await setSetting('sshWorkspaceHosts', previous)
  })

  it('returns null rather than opening a connection', async () => {
    assert.equal(await execOnConnectedSshHost('dev-box', '/srv/app', 'stat a.ts'), null)
    assert.equal(connects, 0, 'background work must never be what starts an SSH connection')
    assert.deepEqual(getSshConnectionManager().listStates(), [])
  })

  it('runs on a connection that is already open', async () => {
    // A command the user ran opens the connection; background work then reuses it.
    await execOnSshHost('dev-box', '/srv/app', 'stat a.ts')
    const result = await execOnConnectedSshHost('dev-box', '/srv/app', 'stat b.ts')
    assert.equal(result?.stdout, 'ok\n')
    assert.equal(connects, 1)
  })
})
