import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import type { TurnPlacement } from '../turn-host/turn-host-link.ts'
import { NO_CAPABILITIES } from '../worker-protocol/worker-capabilities.ts'
import {
  SshTurnHosts,
  sshProjectOf,
  type SshTurnHostDependencies,
  type SshTurnHostLink,
} from './ssh-turn-hosts.ts'

const NODE = { version: '24.1.0', execPath: '/usr/bin/node', home: '/home/me' }
const PROJECT = { id: 'p1', name: 'Site', path: '/srv/site' }
const NEEDS = { model: 'm', pluginRuntimes: false, sandbox: false }

/** A host whose commands all succeed; what ran, by what it was for. */
function connection(failSeed = false): { connection: SshConnection; ran: string[] } {
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
          stdout: kind === 'state' ? '{"size":-1,"prefixHash":"","held":false}\n' : '',
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
  started = true,
  onRun?: () => void,
  settings: Promise<Record<string, unknown>> = Promise.resolve({ model: 'm' }),
): { hosts: SshTurnHosts; events: string[] } {
  const events: string[] = []
  const link: SshTurnHostLink = {
    stop: (threadId): void => {
      events.push(`stop ${threadId}`)
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
      Promise.resolve(
        started
          ? {
              ok: true,
              localSocket: '/l.sock',
              remoteSocket: '/r.sock',
              uploaded: false,
              hello: { version: '1', pid: 1, capabilities: NO_CAPABILITIES },
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
    assert.ok(turnHosts.admits('dev', 't1') && turnHosts.admits('dev', null))
    assert.ok(!turnHosts.admits('dev', 't2') && !turnHosts.admits('other', null))
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

    const full = hosts(connection(true).connection, 'host')
    assert.equal(await full.hosts.run('dev', PROJECT, 't1', '{}', NEEDS), 'app')
    assert.ok(!full.events.includes('run'))
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
