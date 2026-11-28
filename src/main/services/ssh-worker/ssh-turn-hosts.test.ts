import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import type { TurnPlacement } from '../turn-host/turn-host-link.ts'
import type { HostInferRequest } from '../turn-host/turn-host-protocol.ts'
import { NO_CAPABILITIES, type WorkerCapabilities } from '../worker-protocol/worker-capabilities.ts'

const TURNS: WorkerCapabilities = { ...NO_CAPABILITIES, roles: ['turns'] }
import {
  SshTurnHosts,
  sshProjectOf,
  type SshTurnHostDependencies,
  type SshTurnHostLink,
} from './ssh-turn-hosts.ts'

const NODE = { version: '24.1.0', execPath: '/usr/bin/node', home: '/home/me' }
const PROJECT = { id: 'p1', name: 'Site', path: '/srv/site' }
const NEEDS = { model: 'm', pluginRuntimes: false, sandbox: false }

/** The time the hosts see, which a test moves on. */
const clock = { now: 1_000 }

function call(
  threadId: string,
  model: string,
  text = 'hi',
  maxOutputTokens?: number,
): HostInferRequest {
  return {
    t: 'infer',
    id: 'c1',
    threadId,
    model,
    providerOptions: maxOutputTokens === undefined ? {} : { maxOutputTokens },
    messages: [{ role: 'user', content: text }],
    tools: [],
  }
}

/** A host whose commands all succeed; what ran, by what it was for. */
function connection(
  failSeed = false,
  held: () => boolean = () => false,
): { connection: SshConnection; ran: string[] } {
  const ran: string[] = []
  return {
    ran,
    connection: {
      host: { id: 'dev', label: 'Dev Server', host: 'dev.example' },
      transport: new FakeSshTransport(),
      execArgv: (argv): Promise<SshExecResult> => {
        const script = argv[2] ?? ''
        const kind = script.includes('renameSync(part, file)')
          ? 'stores'
          : script.includes("process.stdout.write(text + '")
            ? 'mirror'
            : script.includes('prefixHash')
              ? 'state'
              : (argv[0] ?? '')
        ran.push(kind)
        return Promise.resolve({
          stdout:
            kind === 'state'
              ? `${JSON.stringify({ size: -1, prefixHash: '', held: held() })}\n`
              : '',
          stderr: failSeed && kind === 'stores' ? 'disk full' : '',
          code: failSeed && kind === 'stores' ? 1 : 0,
        })
      },
      execShell: () => Promise.reject(new Error('not used')),
    },
  }
}

function hosts(
  conn: SshConnection,
  placement: TurnPlacement | Promise<TurnPlacement>,
  started: boolean | 'throws' = true,
  onRun?: () => void,
  settings: Promise<Record<string, unknown>> = Promise.resolve({
    model: 'm',
    smallTasksModel: 'small',
  }),
  capabilities: WorkerCapabilities = TURNS,
): { hosts: SshTurnHosts; events: string[] } {
  const events: string[] = []
  const link: SshTurnHostLink = {
    stop: (threadId): void => {
      events.push(`stop ${threadId}`)
    },
    stopAllForQuit: (): Promise<void> => {
      events.push('stop-all')
      return Promise.resolve()
    },
    ensureConnected: (): Promise<boolean> => Promise.resolve(true),
    profileChanged: (): void => {
      events.push('profile-changed')
    },
    run: async (): Promise<TurnPlacement> => {
      events.push('run')
      onRun?.()
      return placement
    },
    close: (): void => {
      events.push('close')
    },
    subscribe: (): null => null,
  }
  const deps: SshTurnHostDependencies = {
    start: () =>
      started === 'throws'
        ? Promise.reject(new Error('the line dropped'))
        : Promise.resolve(
            started
              ? {
                  ok: true,
                  localSocket: '/l.sock',
                  remoteSocket: '/r.sock',
                  uploaded: false,
                  hello: { version: '1', pid: 1, capabilities },
                  node: NODE,
                }
              : { ok: false, reason: 'the user kept turns on this computer' },
          ),
    connection: () => conn,
    settings: () => settings,
    link: () => link,
    follow: () => {
      events.push('follow')
      return () => events.push('unfollow')
    },
    settleRunning: (_projectId, threadId) => {
      events.push(`settle ${threadId}`)
      return Promise.resolve()
    },
    wait: () => Promise.resolve(),
    now: () => clock.now,
    log: () => undefined,
  }
  return { hosts: new SshTurnHosts(deps), events }
}

describe("an SSH thread's turns on its host", () => {
  it('gives the worker the thread, follows the turn and copies it back', async () => {
    const { connection: conn, ran } = connection()
    const { hosts: turnHosts, events } = hosts(conn, 'host')
    assert.equal(await turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'host')
    assert.deepEqual(events, ['profile-changed', 'follow', 'run', 'settle t1', 'unfollow'])
    // Stores, what the host has of the thread, whether the turn still holds
    // it there, then the copy back.
    assert.deepEqual(ran, ['stores', 'state', 'state', 'mirror'])
  })

  it('refuses a prompt for a thread still running there, and stops it there', async () => {
    const ended = Promise.withResolvers<TurnPlacement>()
    const running = Promise.withResolvers<undefined>()
    const { hosts: turnHosts, events } = hosts(connection().connection, ended.promise, true, () => {
      running.resolve(undefined)
    })
    const first = turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS)
    await assert.rejects(turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS), /still running/)
    await running.promise
    assert.deepEqual(turnHosts.runningThreadIds(), ['t1'])
    assert.equal(turnHosts.stop('t1'), true)
    assert.equal(turnHosts.stop('t2'), false)
    assert.ok(events.includes('stop t1'))
    assert.ok(turnHosts.admits('dev', 't1') && turnHosts.admits('dev', 't1', 'p1'))
    assert.ok(!turnHosts.admits('dev', 't2') && !turnHosts.admits('other', 't1'))
    assert.ok(!turnHosts.admits('dev', 't1', 'p2'))
    // The turn's model, and a role model from the settings, are called for it.
    assert.equal(turnHosts.refuseCall('dev', call('t1', 'm')), null)
    assert.equal(turnHosts.refuseCall('dev', call('t1', 'small')), null)
    assert.match(turnHosts.refuseCall('dev', call('t1', 'other-model')) ?? '', /does not use/)
    assert.match(turnHosts.refuseCall('dev', call('t2', 'm')) ?? '', /no turn/)
    assert.match(turnHosts.refuseCall('other', call('t1', 'm')) ?? '', /no turn/)
    assert.match(
      turnHosts.refuseCall('dev', call('t1', 'm', 'x'.repeat(200_000_000))) ?? '',
      /token budget/,
    )
    // What a call may get back counts too.
    assert.match(
      turnHosts.refuseCall('dev', call('t1', 'm', 'hi', 39_900_000)) ?? '',
      /token budget/,
    )
    clock.now += 5 * 60 * 60_000
    assert.match(turnHosts.refuseCall('dev', call('t1', 'm')) ?? '', /time limit/)
    ended.resolve('host')
    assert.equal(await first, 'host')
    assert.deepEqual(turnHosts.runningThreadIds(), [])
  })

  it('copies nothing back for a turn the app runs', async () => {
    const { connection: conn, ran } = connection()
    const { hosts: turnHosts } = hosts(conn, 'app')
    assert.equal(await turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.ok(!ran.includes('mirror'))
  })

  it('runs the turn in the app when the worker cannot start or be given the thread', async () => {
    const declined = hosts(connection().connection, 'host', false)
    assert.equal(await declined.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.deepEqual(declined.events, [])

    // A start that fails outright runs the turn here too, and is tried again.
    const failed = hosts(connection().connection, 'host', 'throws')
    assert.equal(await failed.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.equal(await failed.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    await failed.hosts.stopAllForQuit(10)

    const full = hosts(connection(true).connection, 'host')
    assert.equal(await full.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.ok(!full.events.includes('run'))

    // A worker that says it runs no turns is given nothing of the thread.
    const { connection: conn, ran } = connection()
    const unable = hosts(conn, 'host', true, undefined, undefined, NO_CAPABILITIES)
    assert.equal(await unable.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.deepEqual(ran, [])
    assert.ok(!unable.events.includes('run'))
  })

  it('runs nothing on the host for a turn stopped while it was given the thread', async () => {
    const { connection: conn } = connection()
    const gate = Promise.withResolvers<Record<string, unknown>>()
    const { hosts: turnHosts, events } = hosts(conn, 'host', true, undefined, gate.promise)
    const run = turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS)
    assert.equal(turnHosts.stop('t1'), true)
    gate.resolve({})
    assert.equal(await run, 'host')
    assert.ok(!events.includes('run'))
    assert.ok(events.includes('settle t1'))
  })

  it('keeps a turn the host still holds running here, and stops it there', async () => {
    // From the turn on, the host holds the thread and cannot be read, until
    // the app stops looking (twenty failed reads in a row).
    const looks = { held: false, unreadable: false }
    const base = connection(false, () => looks.held)
    const conn: SshConnection = {
      ...base.connection,
      execArgv: (argv, options) =>
        looks.unreadable && (argv[2] ?? '').includes('prefixHash')
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'gone' })
          : base.connection.execArgv(argv, options),
    }
    const { hosts: turnHosts, events } = hosts(conn, 'host', true, () => {
      looks.held = true
      looks.unreadable = true
    })
    assert.equal(await turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'host')
    assert.deepEqual(turnHosts.runningThreadIds(), ['t1'])
    assert.ok(!events.includes('settle t1'))
    await assert.rejects(turnHosts.run('dev', PROJECT, 't1', '{}', NEEDS), /still running/)

    // The host is back: Stop reaches it, and once it lets go the thread comes back.
    looks.unreadable = false
    looks.held = false
    assert.equal(turnHosts.stop('t1'), true)
    while (turnHosts.runningThreadIds().length > 0)
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve)
      })
    assert.ok(events.includes('stop t1'))
    assert.equal(events.at(-1), 'settle t1')

    await turnHosts.stopAllForQuit(10)
    assert.equal(events.at(-1), 'stop-all')
  })

  it('finds the SSH host of a project, and none for a local or missing one', () => {
    const projects = [
      { id: 'p1', name: 'Site', path: '/srv/site', sshHost: 'dev', worktreeMode: 'never' },
      { id: 'p4', path: 42 },
      { id: 'p2', name: 'Here', path: '/Users/me/here' },
      { id: 'p3', name: 'Gone', path: '/srv/gone', sshHost: 'dev', missing: true },
    ]
    assert.deepEqual(sshProjectOf(projects, 'p1'), {
      hostId: 'dev',
      project: { id: 'p1', name: 'Site', path: '/srv/site' },
    })
    assert.equal(sshProjectOf(projects, 'p2'), null)
    assert.equal(sshProjectOf(projects, 'p3'), null)
    assert.equal(sshProjectOf('not a list', 'p1'), null)
  })
})
