import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  SSH_QUIET_RECONNECT_DELAYS_MS,
  SshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from './connection-manager.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'
import type { SshConnectOptions } from './transport.ts'
import type { SshConnectionState, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

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
        checkAlive: async (): Promise<boolean> => Promise.resolve(false),
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

  describe('liveness', () => {
    const PROBE_SCRIPTS = [
      { when: /^uname -s$/, stdout: 'Linux\n' },
      { when: /^uname -m$/, stdout: 'x86_64\n' },
      { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
      { when: /command -v git$/, stdout: '/usr/bin/git\n' },
      { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
    ]

    /** One fake transport per connect, with a scriptable outcome for each attempt. */
    function harness(onConnect: (options: SshConnectOptions, attempt: number) => void = () => {}): {
      manager: SshConnectionManager
      transports: FakeSshTransport[]
      connects: SshConnectOptions[]
      clock: { now: number }
      statuses: () => Array<SshConnectionState['status']>
    } {
      const transports: FakeSshTransport[] = []
      const connects: SshConnectOptions[] = []
      const clock = { now: 1_000 }
      setSshTransportFactory(() => {
        const transport = new FakeSshTransport(
          [...PROBE_SCRIPTS, { when: /^fail-at-transport$/, code: 255 }],
          {
            onConnect: (options): void => {
              connects.push(options)
              onConnect(options, connects.length)
            },
          },
        )
        transports.push(transport)
        return transport
      })
      // The timer is off: each test decides exactly when a check runs.
      const manager = new SshConnectionManager({
        now: (): number => clock.now,
        livenessIntervalMs: 0,
      })
      return {
        manager,
        transports,
        connects,
        clock,
        statuses: () => manager.listStates().map((state) => state.status),
      }
    }

    it('leaves a healthy connection alone', async () => {
      await withTestHost(async () => {
        const { manager, connects, statuses } = harness()
        await manager.connect('dev-box')
        await manager.checkLiveness()
        assert.deepEqual(statuses(), ['connected'])
        assert.equal(connects.length, 1)
      })
    })

    it('restores a dropped connection quietly, without ever asking for a prompt', async () => {
      await withTestHost(async () => {
        const { manager, transports, connects, statuses } = harness()
        await manager.connect('dev-box')
        const seen: string[] = []
        manager.onChange((states) => seen.push(states.map((state) => state.status).join(',')))

        transports[0]?.dropConnection()
        await manager.checkLiveness()

        assert.deepEqual(statuses(), ['connected'])
        // The window saw the drop before it saw the recovery.
        assert.deepEqual(seen, ['connected', 'disconnected', 'connected'])
        assert.deepEqual(connects, [{}, { quiet: true }])
        // Same transport, so its capabilities and forwards bookkeeping are kept.
        assert.equal(transports.length, 1)
        assert.ok(manager.getConnection('dev-box'))
      })
    })

    it('reports the connection lost when the quiet reconnect cannot succeed', async () => {
      await withTestHost(async () => {
        const { manager, transports, statuses } = harness((options) => {
          if (options.quiet) throw new Error('Permission denied (publickey,password).')
        })
        await manager.connect('dev-box')
        transports[0]?.dropConnection()
        await manager.checkLiveness()

        assert.deepEqual(statuses(), ['disconnected'])
        // Callers must reconnect explicitly rather than use the dead entry.
        assert.equal(manager.getConnection('dev-box'), null)
      })
    })

    it('spaces quiet reconnects out and then stops trying', async () => {
      await withTestHost(async () => {
        const { manager, transports, connects, clock } = harness((options) => {
          if (options.quiet) throw new Error('Network is unreachable')
        })
        await manager.connect('dev-box')
        transports[0]?.dropConnection()
        const quietAttempts = (): number => connects.filter((options) => options.quiet).length

        await manager.checkLiveness()
        assert.equal(quietAttempts(), 1, 'the first attempt is immediate')
        await manager.checkLiveness()
        assert.equal(quietAttempts(), 1, 'no second attempt before its delay has passed')

        const delays = SSH_QUIET_RECONNECT_DELAYS_MS
        for (let attempt = 1; attempt < delays.length; attempt += 1) {
          clock.now += delays[attempt] ?? 0
          await manager.checkLiveness()
          assert.equal(quietAttempts(), attempt + 1)
        }

        clock.now += 24 * 60 * 60 * 1000
        await manager.checkLiveness()
        assert.equal(quietAttempts(), delays.length, 'a host that is gone is not dialled for ever')
      })
    })

    it('notices a connection a command rebuilt on its own', async () => {
      await withTestHost(async () => {
        const { manager, transports, statuses } = harness((options) => {
          if (options.quiet) throw new Error('Network is unreachable')
        })
        await manager.connect('dev-box')
        const transport = transports[0]
        assert.ok(transport)
        transport.dropConnection()
        await manager.checkLiveness()
        assert.deepEqual(statuses(), ['disconnected'])

        // What `ControlMaster=auto` does when a command runs after the drop.
        await transport.connect()
        await manager.checkLiveness()
        assert.deepEqual(statuses(), ['connected'])
      })
    })

    it('leaves the reconnect to the user once the host has been edited', async () => {
      await withTestHost(async () => {
        await setSetting('sshWorkspaceHosts', [{ ...TEST_HOST, forwardAgent: true }])
        const { manager, transports, connects, statuses } = harness()
        await manager.connect('dev-box')
        // The user unticks Forward agent. The transport still holds the old entry.
        await setSetting('sshWorkspaceHosts', [{ ...TEST_HOST, forwardAgent: false }])
        transports[0]?.dropConnection()
        await manager.checkLiveness()

        assert.deepEqual(statuses(), ['disconnected'])
        assert.deepEqual(connects, [{}], 'nothing rebuilt from the entry the user changed')
      })
    })

    it('closes a quiet reconnect that finishes after the host was edited', async () => {
      await withTestHost(async () => {
        let started = (): void => {}
        const reconnecting = new Promise<void>((resolve) => {
          started = resolve
        })
        let release = (): void => {}
        /** Holds the quiet reconnect open so the edit lands while it runs. */
        class HeldReconnect extends FakeSshTransport {
          override async connect(options: SshConnectOptions = {}): Promise<void> {
            if (options.quiet) {
              await new Promise<void>((resolve) => {
                release = resolve
                started()
              })
            }
            await super.connect(options)
          }
        }
        const transport = new HeldReconnect(PROBE_SCRIPTS)
        setSshTransportFactory(() => transport)
        const manager = new SshConnectionManager({
          now: (): number => 1_000,
          livenessIntervalMs: 0,
        })
        await manager.connect('dev-box')

        transport.dropConnection()
        const checking = manager.checkLiveness()
        await reconnecting
        await setSetting('sshWorkspaceHosts', [{ ...TEST_HOST, forwardAgent: true }])
        release()
        await checking

        assert.deepEqual(
          manager.listStates().map((state) => state.status),
          ['disconnected'],
        )
        assert.equal(
          transport.isConnected(),
          false,
          'the master built from the old entry is closed',
        )
      })
    })

    it('lets an explicit connect replace a lost connection', async () => {
      await withTestHost(async () => {
        const { manager, transports, connects, statuses } = harness((options) => {
          if (options.quiet) throw new Error('Permission denied')
        })
        await manager.connect('dev-box')
        transports[0]?.dropConnection()
        await manager.checkLiveness()
        assert.deepEqual(statuses(), ['disconnected'])

        await manager.connect('dev-box')
        assert.deepEqual(statuses(), ['connected'])
        assert.equal(transports.length, 2)
        assert.deepEqual(connects.at(-1), {}, 'a connect the user started may prompt')
      })
    })

    it('checks at once when a command fails at the connection', async () => {
      await withTestHost(async () => {
        const { manager, transports, statuses } = harness((options) => {
          if (options.quiet) throw new Error('Connection refused')
        })
        const connection = await manager.connect('dev-box')
        transports[0]?.dropConnection()

        const result = await connection.execShell('fail-at-transport')
        assert.equal(result.code, 255)
        // No timer tick and no explicit check: the failed command alone starts one.
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.deepEqual(statuses(), ['disconnected'])
      })
    })

    it('does not retry a connect that failed outright', async () => {
      await withTestHost(async () => {
        const { manager, connects, statuses } = harness(() => {
          throw new Error('auth failed')
        })
        await assert.rejects(() => manager.connect('dev-box'), /auth failed/)
        await manager.checkLiveness()
        assert.deepEqual(statuses(), ['error'])
        assert.equal(connects.length, 1)
      })
    })

    it('waits for a quiet reconnect in flight before an explicit connect starts another', async () => {
      await withTestHost(async () => {
        let releaseQuiet: () => void = () => {}
        const quietStarted = new Promise<void>((started) => {
          setSshTransportFactory(() => {
            const transport = new FakeSshTransport(PROBE_SCRIPTS)
            const connect = transport.connect.bind(transport)
            transport.connect = async (options?: SshConnectOptions): Promise<void> => {
              if (options?.quiet) {
                started()
                await new Promise<void>((release) => {
                  releaseQuiet = release
                })
              }
              await connect(options)
            }
            created.push(transport)
            return transport
          })
        })
        const created: FakeSshTransport[] = []
        const manager = new SshConnectionManager({ livenessIntervalMs: 0 })
        await manager.connect('dev-box')
        created[0]?.dropConnection()

        const check = manager.checkLiveness()
        await quietStarted
        const explicit = manager.connect('dev-box')
        releaseQuiet()
        await Promise.all([check, explicit])

        // The quiet attempt restored the link, so no second master was started.
        assert.equal(created.length, 1)
        assert.deepEqual(
          manager.listStates().map((state) => state.status),
          ['connected'],
        )
      })
    })
  })
})
