import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WriterLeaseRecord } from '@copse/thread-store/writer-lease.ts'
import { ForeignTurnFollower, type ForeignTurn } from './foreign-turns.ts'

function lease(threadId: string, owner: string): WriterLeaseRecord {
  return {
    v: 1,
    threadId,
    owner,
    host: 'host',
    pid: 42,
    epoch: 1,
    acquiredAt: 0,
    heartbeatAt: 0,
    ttlMs: 30_000,
  }
}

function follower(
  leases: Map<string, WriterLeaseRecord>,
  running: Record<string, string[]>,
  abandoned: Set<string> = new Set(),
): { follower: ForeignTurnFollower; repaints: ForeignTurn[]; settled: ForeignTurn[] } {
  const repaints: ForeignTurn[] = []
  const settled: ForeignTurn[] = []
  const instance = new ForeignTurnFollower({
    listProjectIds: (): string[] => Object.keys(running),
    listRunningThreadIds: (projectId): Promise<string[]> =>
      Promise.resolve(running[projectId] ?? []),
    readLease: (_projectId, threadId): Promise<WriterLeaseRecord | null> =>
      Promise.resolve(leases.get(threadId) ?? null),
    selfOwner: 'self',
    repaint: (turn): Promise<void> => {
      repaints.push(turn)
      return Promise.resolve()
    },
    leaseAbandoned: (_projectId, threadId): Promise<boolean> =>
      Promise.resolve(abandoned.has(threadId)),
    settleAbandoned: (turn): Promise<void> => {
      settled.push(turn)
      return Promise.resolve()
    },
  })
  return { follower: instance, repaints, settled }
}

describe('ForeignTurnFollower', () => {
  it('follows only running threads another process holds', async () => {
    const leases = new Map([
      ['worker-held', lease('worker-held', 'worker')],
      ['own', lease('own', 'self')],
    ])
    const { follower: f } = follower(leases, { p: ['worker-held', 'own', 'unheld'] })
    try {
      assert.deepEqual(await f.discover(), ['worker-held'])
      assert.equal(f.isFollowing('worker-held'), true)
      assert.equal(f.isFollowing('unheld'), false)
    } finally {
      f.stop()
    }
  })

  it('repaints while held, and once more after the release before letting go', async () => {
    const leases = new Map([['t', lease('t', 'worker')]])
    const { follower: f, repaints } = follower(leases, { p: ['t'] })
    try {
      await f.discover()
      await f.tick()
      assert.equal(repaints.length, 1)
      assert.equal(f.isFollowing('t'), true)

      leases.delete('t')
      await f.tick()
      assert.deepEqual(repaints.at(-1), { projectId: 'p', threadId: 't' })
      assert.equal(repaints.length, 2)
      assert.equal(f.isFollowing('t'), false)
      assert.deepEqual(f.threadIds(), [])
    } finally {
      f.stop()
    }
  })

  it('settles a thread whose holder died without releasing it, and only that one', async () => {
    const leases = new Map([
      ['died', lease('died', 'worker')],
      ['finished', lease('finished', 'worker')],
    ])
    const {
      follower: f,
      settled,
      repaints,
    } = follower(leases, { p: ['died', 'finished'] }, new Set(['died']))
    try {
      await f.discover()
      leases.clear()
      await f.tick()
      assert.deepEqual(settled, [{ projectId: 'p', threadId: 'died' }])
      assert.equal(repaints.length, 2)
      assert.deepEqual(f.threadIds(), [])
    } finally {
      f.stop()
    }
  })

  it('keeps following past a failed read', async () => {
    const errors: unknown[] = []
    let fail = true
    const f = new ForeignTurnFollower({
      listProjectIds: (): string[] => ['p'],
      listRunningThreadIds: (): Promise<string[]> => Promise.resolve(['t']),
      readLease: (): Promise<WriterLeaseRecord> =>
        fail ? Promise.reject(new Error('busy')) : Promise.resolve(lease('t', 'worker')),
      selfOwner: 'self',
      repaint: (): Promise<void> => Promise.resolve(),
      leaseAbandoned: (): Promise<boolean> => Promise.resolve(false),
      settleAbandoned: (): Promise<void> => Promise.resolve(),
      onError: (error): void => {
        errors.push(error)
      },
    })
    try {
      fail = false
      await f.discover()
      fail = true
      await f.tick()
      assert.equal(errors.length, 1)
      assert.equal(f.isFollowing('t'), true)
    } finally {
      f.stop()
    }
  })
})
