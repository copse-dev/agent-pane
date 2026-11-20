import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import {
  runAppleDesktopProbe,
  appleDesktopProbeArgs,
  appleDesktopProbeShortfall,
  decodeAppleDesktopProbeReport,
  APPLE_DESKTOP_PROBE_LABEL,
  APPLE_DESKTOP_GUEST_PROBE,
  type AppleDesktopProbeConfiguration,
} from './apple-desktop-probe.mts'

const name = 'copse-desktop-probe-12345678-1234-1234-1234-123456789abc'
function configuration(): AppleDesktopProbeConfiguration {
  return {
    capAdd: [],
    capDrop: ['ALL'],
    readOnly: true,
    networks: [],
    useInit: true,
    ssh: false,
    virtualization: false,
    publishedPorts: [],
    publishedSockets: [],
    labels: { [APPLE_DESKTOP_PROBE_LABEL]: name },
    resources: { cpus: 2, memoryInBytes: 4 * 1024 ** 3 },
    initProcess: {
      user: { raw: { userString: '1001:1001' } },
      rlimits: [{ limit: 'RLIMIT_NPROC', soft: 512, hard: 512 }],
    },
    mounts: [
      {
        destination: '/tmp',
        source: 'tmpfs',
        options: ['rw', 'exec', 'nosuid', 'nodev'],
        type: { tmpfs: {} },
      },
    ],
  }
}
function firstMount(
  config: AppleDesktopProbeConfiguration,
): AppleDesktopProbeConfiguration['mounts'][number] {
  const mount = config.mounts[0]
  assert.ok(mount)
  return mount
}

function check(config: ReturnType<typeof configuration>): string | null {
  return appleDesktopProbeShortfall(name, JSON.stringify([{ configuration: config }]))
}
const passingReport = {
  uid: 1001,
  noNewPrivileges: true,
  capabilitiesDropped: true,
  rootReadOnly: true,
  noHostMounts: true,
  scratchWritable: true,
  loopbackWorks: true,
  externalNetworkDenied: true,
  loopbackOnly: true,
  noAmbientCredentials: true,
}

describe('Apple desktop preflight', () => {
  it('never supplies a host mount, credential, forwarded socket or host network', () => {
    const args = appleDesktopProbeArgs(name, 'copse-worker:local')
    for (const forbidden of [
      '--mount',
      '--volume',
      '--ssh',
      '--publish',
      '--publish-socket',
      '--virtualization',
      '--cap-add',
    ])
      assert.ok(!args.includes(forbidden), forbidden)
    assert.equal(args[args.indexOf('--network') + 1], 'none')
    assert.equal(args[args.indexOf('--user') + 1], '1001:1001')
    assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/bin/setpriv')
    assert.ok(args.includes('--no-new-privs'))
    assert.ok(args.includes(APPLE_DESKTOP_GUEST_PROBE))
    assert.throws(() => appleDesktopProbeArgs(name, '--privileged'))
    assert.throws(() => appleDesktopProbeArgs('unowned-container', 'worker'))
  })

  it('accepts the exact requested configuration and refuses malformed or incomplete inspection', () => {
    assert.equal(check(configuration()), null)
    for (const text of ['', '{}', '[]', '[{}]', 'null'])
      assert.ok(appleDesktopProbeShortfall(name, text))
    const config = configuration()
    const { ssh: omitted, ...withoutSsh } = config
    assert.equal(omitted, false)
    assert.ok(appleDesktopProbeShortfall(name, JSON.stringify([{ configuration: withoutSsh }])))
  })

  it('refuses configurations that expose host authority or weaken isolation', () => {
    const weakenings: Array<(config: ReturnType<typeof configuration>) => void> = [
      (config): void => {
        config.readOnly = false
      },
      (config): void => {
        config.useInit = false
      },
      (config): void => {
        config.capAdd = ['SYS_ADMIN']
      },
      (config): void => {
        config.capDrop = []
      },
      (config): void => {
        config.networks = [{}]
      },
      (config): void => {
        config.ssh = true
      },
      (config): void => {
        config.virtualization = true
      },
      (config): void => {
        config.publishedSockets = [{}]
      },
      (config): void => {
        config.publishedPorts = [{}]
      },
      (config): void => {
        config.initProcess.user.raw.userString = '0:0'
      },
      (config): void => {
        config.initProcess.rlimits = []
      },
      (config): void => {
        config.resources.cpus = 4
      },
      (config): void => {
        config.resources.memoryInBytes = 8 * 1024 ** 3
      },
      (config): void => {
        config.labels[APPLE_DESKTOP_PROBE_LABEL] = 'another-run'
      },
      (config): void => {
        firstMount(config).source = '/Users/person'
      },
      (config): void => {
        firstMount(config).destination = '/host'
      },
      (config): void => {
        firstMount(config).options = ['rw']
      },
      (config): void => {
        config.mounts.push(firstMount(config))
      },
    ]
    for (const weaken of weakenings) {
      const config = configuration()
      weaken(config)
      assert.ok(check(config), String(weaken))
    }
  })

  it('requires every observed restriction and positive control to pass', () => {
    assert.deepEqual(decodeAppleDesktopProbeReport(JSON.stringify(passingReport)), passingReport)
    for (const key of Object.keys(passingReport)) {
      const report = { ...passingReport, [key]: false }
      assert.throws(() => decodeAppleDesktopProbeReport(JSON.stringify(report)), key)
    }
    assert.throws(() => decodeAppleDesktopProbeReport('{"uid":1001}'))
    assert.throws(() => decodeAppleDesktopProbeReport('noise\n' + JSON.stringify(passingReport)))
  })

  it('checks inspect before starting and removes the guest before returning success', async () => {
    const calls: string[] = []
    const result = await runAppleDesktopProbe(name, 'worker', {
      run: async (args): Promise<string> => {
        calls.push(args[0] ?? '')
        if (args[0] === 'inspect') return JSON.stringify([{ configuration: configuration() }])
        if (args[0] === 'start') return JSON.stringify(passingReport)
        return ''
      },
      remove: async (ownedName): Promise<void> => {
        assert.equal(ownedName, name)
        calls.push('delete')
      },
    })
    assert.deepEqual(result, passingReport)
    assert.deepEqual(calls, ['create', 'inspect', 'start', 'delete'])
  })

  it('never starts a weakened guest and still removes it', async () => {
    const calls: string[] = []
    const config = configuration()
    config.ssh = true
    await assert.rejects(
      runAppleDesktopProbe(name, 'worker', {
        run: async (args): Promise<string> => {
          calls.push(args[0] ?? '')
          return args[0] === 'inspect' ? JSON.stringify([{ configuration: config }]) : ''
        },
        remove: async (): Promise<void> => {
          calls.push('delete')
        },
      }),
      /Refusing to start/,
    )
    assert.deepEqual(calls, ['create', 'inspect', 'delete'])
  })

  it('cleans up a lost create response and reports teardown failure', async () => {
    let removed = false
    await assert.rejects(
      runAppleDesktopProbe(name, 'worker', {
        run: async (): Promise<string> => {
          throw new Error('create reply lost')
        },
        remove: async (): Promise<void> => {
          removed = true
          throw new Error('engine unavailable')
        },
      }),
      /create reply lost; Apple desktop probe teardown failed/,
    )
    assert.equal(removed, true)
  })

  it('cleans up cancellation during attach without accepting an earlier report', async () => {
    let removed = false
    await assert.rejects(
      runAppleDesktopProbe(name, 'worker', {
        run: async (args): Promise<string> => {
          if (args[0] === 'inspect') return JSON.stringify([{ configuration: configuration() }])
          if (args[0] === 'start') throw new Error('aborted')
          return ''
        },
        remove: async (): Promise<void> => {
          removed = true
        },
      }),
      /aborted/,
    )
    assert.equal(removed, true)
  })

  it('ships syntactically valid guest JavaScript', () => {
    // Compile the executable body as an async function after removing only import declarations.
    const body = APPLE_DESKTOP_GUEST_PROBE.replace(/^import .*;$/gm, '')
    assert.doesNotThrow(() => new Script('(async function(){' + body + '\n})'))
  })
})
