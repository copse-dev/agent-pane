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
          ]),
      )

      const manager = new SshConnectionManager()
      const conn = await manager.connect('dev-box')
      assert.equal(conn.host.id, 'dev-box')
      assert.ok(conn.capabilities)
      assert.equal(conn.capabilities.git, true)
      assert.equal(conn.capabilities.rg, false)
      // Missing tools are flags only — warnings is for probe/infrastructure failures.
      assert.equal(conn.capabilities.warnings.length, 0)

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

  it('surfaces connection errors and cleans up the transport', async () => {
    await withTestHost(async () => {
      let disconnectCalls = 0
      setSshTransportFactory(() => ({
        isConnected: (): boolean => false,
        connect: async (): Promise<void> => {
          throw new Error('auth failed')
        },
        disconnect: async (): Promise<void> => {
          disconnectCalls += 1
          await Promise.resolve()
        },
        openForward: async (): Promise<{ localPort: number }> => ({ localPort: 45_000 }),
        closeForward: async (): Promise<void> => {
          await Promise.resolve()
        },
        fetchFile: async (): Promise<void> => {
          await Promise.resolve()
        },
        sizeOf: async (): Promise<number> => Promise.resolve(0),
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
      assert.equal(disconnectCalls, 1)
      const failed = manager.listStates()
      assert.equal(failed.length, 1)
      const failedState = failed[0]
      assert.ok(failedState)
      assert.equal(failedState.status, 'error')
    })
  })

  it('dedupes concurrent connect calls for the same host', async () => {
    await withTestHost(async () => {
      let connectCalls = 0
      setSshTransportFactory(
        () =>
          new FakeSshTransport(
            [
              { when: /^uname -s$/, stdout: 'Linux\n' },
              { when: /^uname -m$/, stdout: 'x86_64\n' },
              { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
              { when: /command -v git$/, stdout: '/usr/bin/git\n' },
              { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
            ],
            {
              onConnect: (): void => {
                connectCalls += 1
              },
            },
          ),
      )

      const manager = new SshConnectionManager()
      const [first, second] = await Promise.all([
        manager.connect('dev-box'),
        manager.connect('dev-box'),
      ])
      assert.equal(first.host.id, second.host.id)
      assert.equal(connectCalls, 1)
    })
  })
  /** A transport whose `connect()` stays pending until the test releases it. */
  class GatedTransport extends FakeSshTransport {
    private release: () => void = () => undefined
    private readonly gate = new Promise<void>((resolve) => {
      this.release = resolve
    })
    disconnects = 0

    override async connect(): Promise<void> {
      await this.gate
      await super.connect()
    }

    override async disconnect(): Promise<void> {
      this.disconnects += 1
      await super.disconnect()
    }

    open(): void {
      this.release()
    }
  }

  it('does not leave a live transport behind when disconnected mid-connect', async () => {
    await withTestHost(async () => {
      const transports: GatedTransport[] = []
      setSshTransportFactory(() => {
        const transport = new GatedTransport()
        transports.push(transport)
        return transport
      })

      const manager = new SshConnectionManager()
      const connecting = manager.connect('dev-box')
      const outcome = connecting.then(
        () => 'connected',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
      const first = transports[0]
      assert.ok(first)

      // The user disconnects (or forgets credentials) before the handshake ends.
      await manager.disconnect('dev-box')
      assert.equal(manager.listStates().length, 0)

      first.open()
      assert.match(await outcome, /closed while connecting/)
      // The handshake that finished late must not survive as an untracked master.
      assert.equal(first.isConnected(), false)
      assert.equal(manager.listStates().length, 0)
      assert.equal(manager.getConnection('dev-box'), null)
    })
  })

  it('reconnect during a pending connect yields a tracked connection', async () => {
    await withTestHost(async () => {
      const transports: GatedTransport[] = []
      setSshTransportFactory(() => {
        const transport = new GatedTransport()
        transports.push(transport)
        return transport
      })

      const manager = new SshConnectionManager()
      const stale = manager.connect('dev-box').then(
        () => 'connected',
        () => 'rejected',
      )
      const reconnecting = manager.reconnect('dev-box')
      // Let reconnect's disconnect finish and its own connect start.
      for (let turn = 0; turn < 50 && transports.length < 2; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      const [first, second] = transports
      assert.ok(first && second)

      first.open()
      assert.equal(await stale, 'rejected')
      // The stale attempt settling must not unregister the newer one, so a
      // further connect still joins it rather than starting a third handshake.
      const joined = manager.connect('dev-box')
      assert.equal(transports.length, 2)
      // The superseded attempt shares the host's control socket with the new
      // one, so it must not tear that socket down after losing the race.
      const disconnectsBeforeNewConnect = first.disconnects
      second.open()
      const conn = await reconnecting
      assert.equal(conn.transport, second)
      assert.equal((await joined).transport, second)
      assert.equal(first.disconnects, disconnectsBeforeNewConnect)

      const states = manager.listStates()
      assert.equal(states.length, 1)
      assert.equal(states[0]?.status, 'connected')
      assert.ok(manager.getConnection('dev-box'))
    })
  })
})
