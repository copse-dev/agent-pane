import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  SshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from './connection-manager.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'
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

describe('SshConnectionManager', () => {
  beforeEach(() => {
    resetSshConnectionManagerForTests()
  })

  afterEach(() => {
    resetSshConnectionManagerForTests()
  })

  it('connects and probes capabilities via fake transport', async () => {
    await withTestHost(async () => {
      setSshTransportFactory(
        () =>
          new FakeSshTransport([
            { when: /^uname -s$/, stdout: 'Linux\n' },
            { when: /^uname -m$/, stdout: 'x86_64\n' },
            { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
            { when: /command -v git$/, stdout: '/usr/bin/git\n' },
            { when: /command -v rg$/, stdout: '', code: 1 },
            { when: /command -v inotifywait$/, stdout: '', code: 1 },
          ]),
      )

      const manager = new SshConnectionManager()
      const conn = await manager.connect('dev-box')
      assert.equal(conn.host.id, 'dev-box')
      assert.ok(conn.capabilities)
      assert.equal(conn.capabilities.git, true)
      assert.equal(conn.capabilities.rg, false)
      assert.match(conn.capabilities.warnings.join(' '), /rg/)

      const states = manager.listStates()
      assert.equal(states.length, 1)
      const state = states[0]
      assert.ok(state)
      assert.equal(state.status, 'connected')
      assert.equal(state.target, 'alice@dev.example.com')

      await manager.disconnect('dev-box')
      assert.equal(manager.listStates().length, 0)
    })
  })

  it('surfaces connection errors', async () => {
    await withTestHost(async () => {
      setSshTransportFactory(() => ({
        isConnected: (): boolean => false,
        connect: async (): Promise<void> => {
          throw new Error('auth failed')
        },
        disconnect: async (): Promise<void> => {
          await Promise.resolve()
        },
        execArgv: async (): Promise<{ stdout: string; stderr: string; code: number }> => ({
          stdout: '',
          stderr: '',
          code: 0,
        }),
        execShell: async (): Promise<{ stdout: string; stderr: string; code: number }> => ({
          stdout: '',
          stderr: '',
          code: 0,
        }),
      }))

      const manager = new SshConnectionManager()
      await assert.rejects(() => manager.connect('dev-box'), /auth failed/)
      const failed = manager.listStates()
      assert.equal(failed.length, 1)
      const failedState = failed[0]
      assert.ok(failedState)
      assert.equal(failedState.status, 'error')
    })
  })
})
