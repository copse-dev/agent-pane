import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WriterLeaseRecord } from '@copse/thread-store/writer-lease.ts'
import { ForeignTurnFollower, type ForeignTurn } from './foreign-turns.ts'
import type { TurnWorkerConnection, WorkerToApp } from './turn-worker-socket.ts'

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
      assert.equal(repaints.length, 1, 'discovering a turn paints it at once')
      await f.tick()
      assert.equal(repaints.length, 2)
      assert.equal(f.isFollowing('t'), true)

      leases.delete('t')
      await f.tick()
      assert.deepEqual(repaints.at(-1), { projectId: 'p', threadId: 't' })
      assert.equal(repaints.length, 3)
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
      const before = repaints.length
      leases.clear()
      await f.tick()
      assert.deepEqual(settled, [{ projectId: 'p', threadId: 'died' }])
      assert.equal(repaints.length - before, 2)
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

describe('ForeignTurnFollower attached to its worker', () => {
  interface Line {
    sent: string[]
    closed: boolean
    drop: () => void
  }

  function attachedFollower(
    leases: Map<string, WriterLeaseRecord>,
    answers: () => boolean,
  ): {
    follower: ForeignTurnFollower
    repaints: ForeignTurn[]
    delivered: WorkerToApp[]
    lines: Line[]
  } {
    const repaints: ForeignTurn[] = []
    const delivered: WorkerToApp[] = []
    const lines: Line[] = []
    const instance = new ForeignTurnFollower({
      listProjectIds: (): string[] => ['p'],
      listRunningThreadIds: (): Promise<string[]> => Promise.resolve(['t']),
      readLease: (_projectId, threadId): Promise<WriterLeaseRecord | null> =>
        Promise.resolve(leases.get(threadId) ?? null),
      selfOwner: 'self',
      repaint: (turn): Promise<void> => {
        repaints.push(turn)
        return Promise.resolve()
      },
      connect: (_turn, onMessage, onClose): Promise<TurnWorkerConnection | null> => {
        if (!answers()) return Promise.resolve(null)
        const line: Line = {
          sent: [],
          closed: false,
          drop: (): void => {
            onClose()
          },
        }
        lines.push(line)
        onMessage({ t: 'chunk', threadId: 't', chunk: { type: 'text', text: 'live' } })
        return Promise.resolve({
          send: (message): void => {
            line.sent.push(message.t)
          },
          close: (): void => {
            line.closed = true
          },
        })
      },
      deliver: (message): void => {
        delivered.push(message)
      },
      leaseAbandoned: (): Promise<boolean> => Promise.resolve(false),
      settleAbandoned: (): Promise<void> => Promise.resolve(),
    })
    return { follower: instance, repaints, delivered, lines }
  }

  it('streams from the worker instead of repainting, and stops through it', async () => {
    const leases = new Map([['t', lease('t', 'worker')]])
    const { follower: f, repaints, delivered, lines } = attachedFollower(leases, () => true)
    try {
      await f.discover()
      assert.equal(f.isAttached('t'), true)
      assert.deepEqual(lines.at(0)?.sent, ['attach'])
      assert.equal(delivered.length, 1)
      await f.tick()
      assert.equal(repaints.length, 0)

      assert.equal(f.requestStop('t'), true)
      assert.deepEqual(lines.at(0)?.sent, ['attach', 'stop'])
      f.reattach('p', ['t'])
      assert.deepEqual(lines.at(0)?.sent, ['attach', 'stop', 'attach'])

      leases.delete('t')
      await f.tick()
      assert.equal(lines.at(0)?.closed, true)
      assert.equal(repaints.length, 1)
      assert.equal(f.isFollowing('t'), false)
    } finally {
      f.stop()
    }
  })

  it('repaints from disk while no worker answers, and reattaches when the line drops', async () => {
    const leases = new Map([['t', lease('t', 'worker')]])
    let answering = false
    const { follower: f, repaints, lines } = attachedFollower(leases, () => answering)
    try {
      await f.discover()
      assert.equal(f.isAttached('t'), false)
      // Pressed while the worker is still starting: kept until it answers.
      assert.equal(f.requestStop('t'), true)
      assert.equal(f.requestStop('unfollowed'), false)
      assert.equal(repaints.length, 1)

      answering = true
      await f.tick()
      assert.equal(f.isAttached('t'), true)
      assert.equal(repaints.length, 1)
      assert.deepEqual(lines.at(0)?.sent, ['attach', 'stop'])

      lines.at(0)?.drop()
      assert.equal(f.isAttached('t'), false)
      await f.tick()
      assert.equal(lines.length, 2)
      assert.equal(f.isAttached('t'), true)
    } finally {
      f.stop()
    }
  })
})
