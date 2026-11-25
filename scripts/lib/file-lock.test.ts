import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { withFileLock } from './file-lock.mts'

async function scratchLock(): Promise<{ path: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'file-lock-'))
  return { path: join(dir, 'nested', 'run.lock'), done: () => rm(dir, { recursive: true }) }
}

/** A pid that certainly belonged to a process and certainly no longer does. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.ok(child.pid > 0)
  return child.pid
}

const FAST = { waitMs: 2_000, staleMs: 60_000, pollMs: 5 }

describe('withFileLock', () => {
  it('runs the work, returns its value, and leaves no lock behind', async () => {
    const lock = await scratchLock()
    try {
      const result = await withFileLock(lock.path, () => Promise.resolve(42), FAST)
      assert.deepEqual(result, { ran: true, value: 42 })
      assert.equal(existsSync(lock.path), false)
    } finally {
      await lock.done()
    }
  })

  it('never lets two holders overlap', async () => {
    const lock = await scratchLock()
    try {
      let inside = 0
      let most = 0
      // Holding the lock across several event-loop turns is enough: were the
      // lock broken, all four holders would be inside at once and interleave
      // here. No wall-clock wait is needed to see that.
      const work = async (): Promise<void> => {
        inside++
        most = Math.max(most, inside)
        for (let turn = 0; turn < 5; turn++) await sleep(0)
        inside--
      }
      const results = await Promise.all(
        Array.from({ length: 4 }, () => withFileLock(lock.path, work, FAST)),
      )
      assert.ok(results.every((result) => result.ran))
      assert.equal(most, 1)
    } finally {
      await lock.done()
    }
  })

  it('releases the lock when the work throws', async () => {
    const lock = await scratchLock()
    try {
      await assert.rejects(
        withFileLock(lock.path, () => Promise.reject(new Error('boom')), FAST),
        /boom/,
      )
      assert.equal(existsSync(lock.path), false)
    } finally {
      await lock.done()
    }
  })

  it('takes over a lock whose holder has died', async () => {
    const lock = await scratchLock()
    try {
      await withFileLock(lock.path, () => Promise.resolve(), FAST) // creates the directory
      await writeFile(lock.path, String(deadPid()))
      const result = await withFileLock(lock.path, () => Promise.resolve('mine'), FAST)
      assert.deepEqual(result, { ran: true, value: 'mine' })
    } finally {
      await lock.done()
    }
  })

  it('takes over a lock older than staleMs even if its pid looks alive', async () => {
    const lock = await scratchLock()
    try {
      await withFileLock(lock.path, () => Promise.resolve(), FAST)
      await writeFile(lock.path, String(process.pid))
      const anHourAgo = new Date(Date.now() - 3_600_000)
      await utimes(lock.path, anHourAgo, anHourAgo)
      const result = await withFileLock(lock.path, () => Promise.resolve('mine'), FAST)
      assert.deepEqual(result, { ran: true, value: 'mine' })
    } finally {
      await lock.done()
    }
  })

  it('gives up after waitMs on a live holder, without running or touching its lock', async () => {
    const lock = await scratchLock()
    try {
      await withFileLock(lock.path, () => Promise.resolve(), FAST)
      await writeFile(lock.path, String(process.pid))
      let ran = false
      const result = await withFileLock(
        lock.path,
        () => {
          ran = true
          return Promise.resolve()
        },
        { waitMs: 50, staleMs: 60_000, pollMs: 5 },
      )
      assert.deepEqual(result, { ran: false })
      assert.equal(ran, false)
      assert.equal(existsSync(lock.path), true)
    } finally {
      await lock.done()
    }
  })
})
