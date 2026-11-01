import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  ChildCopseSessions,
  isChildCopseTarget,
  type ChildCopseBackend,
} from './child-copse-sessions.ts'
import { decideDesktopAppAccess } from './desktop-app-policy.ts'
import type { DesktopApp } from './desktop-control-service.ts'

const stores: ChildCopseSessions[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.revokeAll()))
})

interface Harness {
  sessions: ChildCopseSessions
  running: Set<string>
  stopped: string[]
  start: () => Promise<string>
  stopControl: () => void
  closed: () => number
}

const noControl = async (): Promise<() => void> => (): void => undefined

function harness(): Harness {
  const running = new Set<string>()
  const stopped: string[] = []
  let stopControl = (): void => undefined
  let closed = 0
  const backend: ChildCopseBackend = {
    start: async (id) => {
      running.add(id)
      return {
        pid: 42,
        name: 'Child Copse',
        bundleId: 'dev.copse.app',
        active: false,
        hidden: false,
      }
    },
    validate: async (id) => {
      if (!running.has(id)) throw new Error('Child exited')
      return {
        pid: 42,
        name: 'Child Copse',
        bundleId: 'dev.copse.app',
        active: false,
        hidden: false,
      }
    },
    stop: async (id) => {
      stopped.push(id)
      running.delete(id)
    },
  }
  const sessions = new ChildCopseSessions(backend)
  stores.push(sessions)
  const start = async (): Promise<string> => {
    sessions.approveStart('owner')
    return sessions.start(
      'owner',
      '/Copse.app',
      '/build/index.js',
      '/fresh-profile',
      async (stop): Promise<() => void> => {
        stopControl = stop
        return (): void => {
          closed++
        }
      },
    )
  }
  return {
    sessions,
    running,
    stopped,
    start,
    stopControl: (): void => {
      stopControl()
    },
    closed: (): number => closed,
  }
}

describe('Child Copse session authority', () => {
  it('requires explicit launch consent and consumes it once', async () => {
    const h = harness()
    await assert.rejects(h.sessions.start('owner', '', '', '', noControl), /requires approval/)
    const target = await h.start()
    assert.ok(isChildCopseTarget(target))
    assert.equal((await h.sessions.resolve(target, 'owner')).pid, 42)
    await assert.rejects(h.sessions.start('owner', '', '', '', noControl), /requires approval/)
  })

  it('never grants a Copse bundle id or a different thread access to the child', async () => {
    const h = harness()
    const target = await h.start()
    await assert.rejects(h.sessions.resolve(target, 'another-thread'), /owned by this thread/)
    for (const app of ['dev.copse.app', 'dev.copse.app-dev', 'dev.copse.desktop-control']) {
      assert.equal(
        decideDesktopAppAccess({ bundleId: app, allowedBundleIds: [app] }).action,
        'deny',
      )
      await assert.rejects(h.sessions.resolve(app, 'owner'), /No active child/)
    }
    await assert.rejects(
      h.sessions.resolve('child:00000000-0000-0000-0000-000000000000', 'owner'),
      /No active child/,
    )
  })

  it('revokes synchronously from the visible Stop control and closes only its child', async () => {
    const h = harness()
    const target = await h.start()
    h.stopControl()
    assert.deepEqual(h.sessions.list('owner'), [])
    await assert.rejects(h.sessions.resolve(target, 'owner'), /No active child/)
    assert.equal(h.closed(), 1)
    assert.deepEqual(h.stopped, [target.slice(6)])
  })

  it('detects child exit without transferring authority to another process', async () => {
    const h = harness()
    const target = await h.start()
    h.running.clear()
    await assert.rejects(h.sessions.resolve(target, 'owner'), /Child exited/)
    assert.deepEqual(h.sessions.list('owner'), [])
    assert.equal(h.closed(), 1)
    // A process with the same PID returning later cannot revive the handle.
    h.running.add(target.slice(6))
    await assert.rejects(h.sessions.resolve(target, 'owner'), /No active child/)
  })

  it('expires automatically after thirty minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = harness()
    const target = await h.start()
    t.mock.timers.tick(30 * 60_000)
    assert.deepEqual(h.sessions.list('owner'), [])
    await assert.rejects(h.sessions.resolve(target, 'owner'), /No active child/)
  })

  it('cannot gain control when disabled while native launch is pending', async () => {
    const pending = Promise.withResolvers<DesktopApp>()
    const stopped: string[] = []
    const backend: ChildCopseBackend = {
      start: (): Promise<DesktopApp> => pending.promise,
      validate: async (): Promise<DesktopApp> => {
        throw new Error('not registered')
      },
      stop: async (id): Promise<void> => {
        stopped.push(id)
      },
    }
    const sessions = new ChildCopseSessions(backend)
    stores.push(sessions)
    sessions.approveStart('owner')
    const starting = sessions.start('owner', '', '', '', noControl)
    await sessions.revokeAll()
    pending.resolve({ pid: 42, name: 'Child', active: false, hidden: false })
    await assert.rejects(starting, /revoked/)
    assert.equal(stopped.length, 1)
    assert.deepEqual(sessions.list('owner'), [])
  })

  it('cleans up a child when its launch response is lost', async () => {
    const stopped: string[] = []
    const backend: ChildCopseBackend = {
      start: async (): Promise<DesktopApp> => {
        throw new Error('reply lost')
      },
      validate: async (): Promise<DesktopApp> => {
        throw new Error('not registered')
      },
      stop: async (id): Promise<void> => {
        stopped.push(id)
      },
    }
    const sessions = new ChildCopseSessions(backend)
    stores.push(sessions)
    sessions.approveStart('owner')
    await assert.rejects(sessions.start('owner', '', '', '', noControl), /reply lost/)
    assert.equal(stopped.length, 1)
    assert.deepEqual(sessions.list('owner'), [])
  })

  it('revokes all active sessions and pending launch consent on disable', async () => {
    const h = harness()
    const target = await h.start()
    h.sessions.approveStart('owner')
    await h.sessions.revokeAll()
    await assert.rejects(h.sessions.resolve(target, 'owner'), /No active child/)
    await assert.rejects(h.sessions.start('owner', '', '', '', noControl), /requires approval/)
  })
})
