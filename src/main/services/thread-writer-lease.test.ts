import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  acquireWriterLease,
  readWriterLease,
  type WriterLeaseEnvironment,
} from '@copse/thread-store/writer-lease.ts'
import { claimThreadWriter } from './thread-writer-lease.ts'

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function threadDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'thread-writer-'))
  dirs.push(dir)
  return dir
}

function env(id: string, now: () => number): WriterLeaseEnvironment {
  return {
    owner: { id, host: 'host', pid: id === 'app' ? 1 : 2 },
    now,
    isAlive: () => true,
    sleep: async (): Promise<void> => {
      await Promise.resolve()
    },
  }
}

/** Yield to I/O, without a wall-clock sleep, until `condition` holds. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 100_000; turn += 1) {
    if (await condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('timed out')
}

describe('claimThreadWriter', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })

  it('keeps the lease alive past its time-to-live while the turn runs, then gives it back', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const app = env('app', () => clock.at)
    const result = await claimThreadWriter('p', 't', {
      onLost: () => assert.fail('the lease was not lost'),
      env: app,
      ttlMs: 60,
      threadDir: dir,
    })
    assert.ok(result.status === 'claimed')
    // Several heartbeats carry it well past the 60 ms it was taken for.
    for (let beat = 1; beat <= 5; beat += 1) {
      clock.at += 20
      mock.timers.tick(20)
      const expected = clock.at
      await until(async () => (await readWriterLease(dir, 't', app))?.heartbeatAt === expected)
    }
    assert.equal(
      (
        await readWriterLease(
          dir,
          't',
          env('worker', () => clock.at),
        )
      )?.owner,
      'app',
    )
    await result.claim.release()
    assert.equal(await readWriterLease(dir, 't', app), null)
  })

  it('reports the other holder without taking the lease', async () => {
    const dir = await threadDir()
    await acquireWriterLease(
      dir,
      't',
      env('worker', () => 1_000),
      30_000,
    )
    const result = await claimThreadWriter('p', 't', {
      onLost: () => undefined,
      env: env('app', () => 1_000),
      threadDir: dir,
    })
    assert.deepEqual(result, { status: 'held', holder: { host: 'host', pid: 2, owner: 'worker' } })
  })

  it('tells the turn to stop once another process has taken the lease over', async () => {
    const dir = await threadDir()
    let lost = 0
    const result = await claimThreadWriter('p', 't', {
      onLost: () => {
        lost += 1
      },
      env: env('app', () => 1_000),
      ttlMs: 30,
      threadDir: dir,
    })
    assert.ok(result.status === 'claimed')
    // A process whose clock says the heartbeat expired takes the thread over.
    const later = env('worker', () => 100_000)
    assert.equal((await acquireWriterLease(dir, 't', later, 30_000)).status, 'acquired')
    mock.timers.tick(10)
    await until(() => lost > 0)
    // The heartbeat stopped: later beats do not report the loss again.
    mock.timers.tick(100)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(lost, 1)
    await result.claim.release()
    // Releasing a lost lease leaves the new holder's alone.
    assert.equal((await readWriterLease(dir, 't', later))?.owner, 'worker')
  })
})
