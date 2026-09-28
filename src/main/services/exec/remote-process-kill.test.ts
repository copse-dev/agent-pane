import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { killRemoteProcessGroup } from './remote-process-kill.ts'

const HOST: SshWorkspaceHost = {
  id: 'remote-kill-test',
  label: 'Remote kill test',
  host: 'dev.example.com',
  user: 'alice',
}

describe('killRemoteProcessGroup', () => {
  beforeEach(() => {
    resetSshConnectionManagerForTests()
  })

  afterEach(() => {
    resetSshConnectionManagerForTests()
  })

  it('rejects when SSH could not deliver the remote signals', async () => {
    const previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
    const transport = new FakeSshTransport([
      { when: /^uname -s$/, stdout: 'Linux\n' },
      { when: /^uname -m$/, stdout: 'x86_64\n' },
      { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
      { when: /command -v git$/, stdout: '/usr/bin/git\n' },
      { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
      { when: /^kill -TERM/, stderr: 'SSH control socket lost', code: 255 },
    ])
    await setSetting('sshWorkspaceHosts', [HOST])
    setSshTransportFactory(() => transport)
    try {
      await getSshConnectionManager().connect(HOST.id)

      await assert.rejects(() => killRemoteProcessGroup(HOST.id, 4321), /SSH control socket lost/)
      assert.equal(
        transport.calls.filter((call) => call.kind === 'shell' && call.command.startsWith('kill '))
          .length,
        1,
      )
    } finally {
      await setSetting('sshWorkspaceHosts', previousHosts)
    }
  })
})
