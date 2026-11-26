import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { withFileLock } from './file-lock.mts'

async function scratchLock(): Promise<{ path: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'file-lock-'))
  return { path: join(dir, 'nested', 'run.lock'), done: () => rm(dir, { recursive: true }) }
}

/** A lock file some other holder left, last touched `ageMs` ago. */
async function foreignLock(path: string, ageMs: number): Promise<void> {
  await withFileLock(path, () => Promise.resolve(), FAST) // creates the directory
  await writeFile(path, 'someone-else')
  const touched = new Date(Date.now() - ageMs)
  await utimes(path, touched, touched)
}

const FAST = { waitMs: 2_000, staleMs: 60_000, heartbeatMs: 1_000, pollMs: 5 }

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

  it('takes over a lock whose holder stopped refreshing it', async () => {
    const lock = await scratchLock()
    try {
      await foreignLock(lock.path, 3_600_000)
      const result = await withFileLock(lock.path, () => Promise.resolve('mine'), FAST)
      assert.deepEqual(result, { ran: true, value: 'mine' })
    } finally {
      await lock.done()
    }
  })

  it('gives up after waitMs on a fresh lock, without running or touching it', async () => {
    const lock = await scratchLock()
    try {
      await foreignLock(lock.path, 0)
      let ran = false
      const result = await withFileLock(
        lock.path,
        () => {
          ran = true
          return Promise.resolve()
        },
        { ...FAST, waitMs: 50 },
      )
      assert.deepEqual(result, { ran: false })
      assert.equal(ran, false)
      assert.equal(await readFile(lock.path, 'utf8'), 'someone-else')
    } finally {
      await lock.done()
    }
  })

  it("leaves a reclaimer's lock in place when it releases", async () => {
    const lock = await scratchLock()
    try {
      // The holder stalls past staleMs; another process reclaims the lock and
      // writes its own token. The stalled holder's release must not delete it.
      await withFileLock(lock.path, () => writeFile(lock.path, 'the-reclaimer'), FAST)
      assert.equal(await readFile(lock.path, 'utf8'), 'the-reclaimer')
    } finally {
      await lock.done()
    }
  })

  it('keeps a long-held lock fresh, so waiters do not reclaim it', async () => {
    const lock = await scratchLock()
    try {
      const result = await withFileLock(
        lock.path,
        async () => {
          // Age the file as if the holder had gone quiet, then wait for the
          // next beat to bring it back — an event, not a timed pause.
          const ancient = new Date(Date.now() - 3_600_000)
          await utimes(lock.path, ancient, ancient)
          for (let turn = 0; turn < 5_000; turn++) {
            if (Date.now() - (await stat(lock.path)).mtimeMs < 60_000) return 'refreshed'
            await sleep(0)
          }
          return 'never refreshed'
        },
        { ...FAST, heartbeatMs: 5 },
      )
      assert.deepEqual(result, { ran: true, value: 'refreshed' })
    } finally {
      await lock.done()
    }
  })
})
