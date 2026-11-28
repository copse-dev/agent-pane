import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { packArchive, packageFromArchive } from './ssh-worker-package.ts'
import {
  forgetSshWorkerApprovals,
  startSshWorker,
  type SshWorkerDependencies,
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
    const key = argv[0] === '/usr/bin/node' ? 'unpack' : (argv[0] ?? '')
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

function deps(connection: SshConnection, approve = true): SshWorkerDependencies {
  return {
    version: '1.2.3',
    userDataPath: '/profile',
    connection: () => connection,
    approve: () => Promise.resolve(approve),
    workerPackage: () =>
      packageFromArchive(packArchive([{ path: 'a', mode: 0o644, data: Buffer.from('a') }])),
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
    assert.deepEqual(ran, ['node', 'test', 'unpack', 'sh'])
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
    assert.deepEqual(ran, ['node', 'test', 'sh'])
  })

  it('touches nothing on the host when the user declines', async () => {
    const { connection, ran } = await host({ node: { stdout: NODE } })
    const started = await startSshWorker('dev', deps(connection, false))
    assert.deepEqual(started, { ok: false, reason: 'the user kept turns on this computer' })
    assert.deepEqual(ran, ['node'])
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
})
