import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { NO_CAPABILITIES } from '../worker-protocol/worker-capabilities.ts'
import { packArchive, packageFromArchive } from './ssh-worker-package.ts'
import {
  forgetSshWorkerApprovals,
  startSshWorker,
  type SshWorkerDependencies,
  type SshWorkerHello,
} from './ssh-worker.ts'

const NODE = '{"version":"24.1.0","execPath":"/usr/bin/node","home":"/home/me"}'

interface Host {
  connection: SshConnection
  transport: FakeSshTransport
  /** What each command run on the host was, by its first word. */
  ran: string[]
}

/** A connected host whose commands answer by their first argv word. */
async function host(answers: Record<string, Partial<SshExecResult>>): Promise<Host> {
  const transport = new FakeSshTransport()
  await transport.connect()
  const ran: string[] = []
  const answer = (argv: string[]): SshExecResult => {
    const key =
      argv[0] === '/usr/bin/node'
        ? argv[2]?.includes('execFileSync')
          ? 'prune'
          : 'unpack'
        : (argv[0] ?? '')
    ran.push(key)
    return { stdout: '', stderr: '', code: 0, ...answers[key] }
  }
  return {
    transport,
    ran,
    connection: {
      host: { id: 'dev', label: 'Dev Server', host: 'dev.example' },
      transport,
      execArgv: (argv) => Promise.resolve(answer(argv)),
      execShell: () => Promise.reject(new Error('not used')),
    },
  }
}

const HELLO: SshWorkerHello = { version: '1.2.3', pid: 42, capabilities: NO_CAPABILITIES }

function deps(connection: SshConnection, approve = true): SshWorkerDependencies {
  return {
    version: '1.2.3',
    hello: () => Promise.resolve(HELLO),
    retireWaitMs: 0,
    userDataPath: '/profile',
    connection: () => connection,
    approve: () => Promise.resolve(approve),
    workerPackage: () =>
      Promise.resolve(
        packageFromArchive(packArchive([{ path: 'a', mode: 0o644, data: Buffer.from('a') }])),
      ),
  }
}

describe('starting the worker on an SSH host', () => {
  beforeEach(() => {
    forgetSshWorkerApprovals()
  })

  it('uploads a missing build, starts it and forwards a socket to it', async () => {
    const { connection, transport, ran } = await host({
      node: { stdout: NODE },
      test: { code: 1 },
      sh: { stdout: '/home/me/.copse/worker/x/profile/run/turn-host.sock\n' },
    })
    const started = await startSshWorker('dev', deps(connection))
    assert.ok(started.ok)
    assert.equal(started.uploaded, true)
    assert.deepEqual(ran, ['node', 'test', 'unpack', 'sh', 'prune'])
    assert.deepEqual(started.hello, HELLO)
    assert.equal(
      transport.socketForwards.get(started.localSocket),
      '/home/me/.copse/worker/x/profile/run/turn-host.sock',
    )
  })

  it('starts a build the host already has without uploading it', async () => {
    const { connection, ran } = await host({
      node: { stdout: NODE },
      sh: { stdout: '/run/w.sock\n' },
    })
    const started = await startSshWorker('dev', deps(connection))
    assert.ok(started.ok)
    assert.equal(started.uploaded, false)
    assert.deepEqual(ran, ['node', 'test', 'sh', 'prune'])
  })

  it('touches nothing on the host when the user declines', async () => {
    const { connection, ran } = await host({ node: { stdout: NODE } })
    const started = await startSshWorker('dev', deps(connection, false))
    assert.deepEqual(started, { ok: false, reason: 'the user kept turns on this computer' })
    assert.deepEqual(ran, ['node'])
  })

  it('shares one start between two callers, and asks once', async () => {
    const { connection, ran } = await host({
      node: { stdout: NODE },
      sh: { stdout: '/run/w.sock\n' },
    })
    let asked = 0
    const shared = {
      ...deps(connection),
      approve: (): Promise<boolean> => {
        asked++
        return Promise.resolve(true)
      },
    }
    const [first, second] = await Promise.all([
      startSshWorker('dev', shared),
      startSshWorker('dev', shared),
    ])
    assert.equal(first, second)
    assert.equal(asked, 1)
    assert.deepEqual(ran, ['node', 'test', 'sh', 'prune'])
  })

  it('remembers a refusal for the rest of the run', async () => {
    const { connection } = await host({ node: { stdout: NODE } })
    let asked = 0
    const declining = {
      ...deps(connection),
      approve: (): Promise<boolean> => {
        asked++
        return Promise.resolve(false)
      },
    }
    await startSshWorker('dev', declining)
    const again = await startSshWorker('dev', declining)
    assert.ok(!again.ok)
    assert.equal(asked, 1)
  })

  it('says why when the worker cannot be packed', async () => {
    const { connection } = await host({ node: { stdout: NODE } })
    const started = await startSshWorker('dev', {
      ...deps(connection),
      workerPackage: () => Promise.reject(new Error('ENOENT: apply-seccomp')),
    })
    assert.ok(!started.ok)
    assert.match(started.reason, /could not pack the worker: .*apply-seccomp/)
  })

  it('says so when the host has no Node new enough', async () => {
    const old = await host({
      node: { stdout: '{"version":"20.1.0","execPath":"/usr/bin/node","home":"/h"}' },
    })
    const tooOld = await startSshWorker('dev', deps(old.connection))
    assert.ok(!tooOld.ok)
    assert.match(tooOld.reason, /20\.1\.0/)

    const none = await host({ node: { code: 127, stderr: 'node: not found' } })
    const missing = await startSshWorker('dev', deps(none.connection))
    assert.ok(!missing.ok)
    assert.match(missing.reason, /no Node/)
  })

  it("reports the end of the worker's log when it does not start", async () => {
    const { connection } = await host({
      node: { stdout: NODE },
      sh: { code: 1, stderr: 'Error: Cannot find module x\n' },
    })
    const started = await startSshWorker('dev', deps(connection))
    assert.ok(!started.ok)
    assert.match(started.reason, /Cannot find module x/)
  })

  /** A host whose worker answers each probe with the next of `versions`. */
  function workers(versions: (string | null)[]): {
    hello: NonNullable<SshWorkerDependencies['hello']>
    stopTurns: () => Promise<void>
    retired: () => number
    stopped: () => number
  } {
    let retired = 0
    let stopped = 0
    let last: string | null = null
    return {
      hello: (_socket, probe): Promise<SshWorkerHello | null> => {
        if (!probe) {
          retired++
          return Promise.resolve(last === null ? null : { ...HELLO, version: last })
        }
        last = versions.length > 1 ? (versions.shift() ?? null) : (versions[0] ?? null)
        return Promise.resolve(last === null ? null : { ...HELLO, version: last })
      },
      stopTurns: (): Promise<void> => {
        stopped++
        return Promise.resolve()
      },
      retired: () => retired,
      stopped: () => stopped,
    }
  }

  it('lets a worker of an older build retire, then starts this one', async () => {
    const { connection, transport, ran } = await host({
      node: { stdout: NODE },
      sh: { stdout: '/run/w.sock\n' },
    })
    // The old worker exits between a start and its hello once.
    const worker = workers(['1.2.2', null, '1.2.3'])
    const started = await startSshWorker('dev', { ...deps(connection), ...worker })
    assert.ok(started.ok)
    assert.equal(started.hello.version, '1.2.3')
    assert.equal(worker.retired(), 1)
    assert.equal(worker.stopped(), 0)
    assert.deepEqual(ran, ['node', 'test', 'sh', 'sh', 'sh', 'prune'])
    assert.equal(transport.socketForwards.size, 1)
  })

  it('leaves a worker of a newer Copse alone', async () => {
    const { connection, transport, ran } = await host({
      node: { stdout: NODE },
      sh: { stdout: '/run/w.sock\n' },
    })
    const worker = workers(['1.3.0'])
    const started = await startSshWorker('dev', { ...deps(connection), ...worker })
    assert.ok(!started.ok)
    assert.match(started.reason, /newer Copse \(1\.3\.0\); update Copse/)
    assert.equal(worker.retired(), 0)
    assert.deepEqual(ran, ['node', 'test', 'sh'])
    assert.equal(transport.socketForwards.size, 0)
  })

  it("stops an older worker's turns when it does not make way, then gives up", async () => {
    const { connection, transport, ran } = await host({
      node: { stdout: NODE },
      sh: { stdout: '/run/w.sock\n' },
    })
    const worker = workers(['1.2.2'])
    const started = await startSshWorker('dev', { ...deps(connection), ...worker })
    assert.ok(!started.ok)
    assert.match(started.reason, /1\.2\.2 on the host did not make way/)
    assert.equal(worker.retired(), 1)
    assert.equal(worker.stopped(), 1)
    assert.equal(ran.filter((key) => key === 'sh').length, 10)
    assert.ok(!ran.includes('prune'))
    assert.equal(transport.socketForwards.size, 0)
  })

  it('fails when the worker does not answer on the forward', async () => {
    const { connection } = await host({ node: { stdout: NODE }, sh: { stdout: '/run/w.sock\n' } })
    const started = await startSshWorker('dev', {
      ...deps(connection),
      hello: () => Promise.resolve(null),
    })
    assert.deepEqual(started, { ok: false, reason: 'the worker did not answer' })
  })
})
