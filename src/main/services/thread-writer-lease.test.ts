import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('claimThreadWriter', () => {
  it('keeps the lease alive past its time-to-live while the turn runs, then gives it back', async () => {
    const dir = await threadDir()
    const app = env('app', Date.now)
    const result = await claimThreadWriter('p', 't', {
      onLost: () => assert.fail('the lease was not lost'),
      env: app,
      ttlMs: 60,
      threadDir: dir,
    })
    assert.ok(result.status === 'claimed')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal((await readWriterLease(dir, 't', app))?.owner, 'app')
    await result.claim.release()
    assert.equal(await readWriterLease(dir, 't', app), null)
  })

  it('reports the other holder without taking the lease', async () => {
    const dir = await threadDir()
    await acquireWriterLease(dir, 't', env('worker', Date.now), 30_000)
    const result = await claimThreadWriter('p', 't', {
      onLost: () => undefined,
      env: env('app', Date.now),
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
      env: env('app', Date.now),
      ttlMs: 30,
      threadDir: dir,
    })
    assert.ok(result.status === 'claimed')
    // A process whose clock says the heartbeat expired takes the thread over.
    const later = env('worker', () => Date.now() + 60_000)
    assert.equal((await acquireWriterLease(dir, 't', later, 30_000)).status, 'acquired')
    await until(() => lost > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(lost, 1)
    await result.claim.release()
    // Releasing a lost lease leaves the new holder's alone.
    assert.equal((await readWriterLease(dir, 't', later))?.owner, 'worker')
  })
})
