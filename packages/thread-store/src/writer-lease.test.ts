import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'
import {
  acquireWriterLease,
  readWriterLease,
  writerLeaseWasAbandoned,
  releaseWriterLease,
  renewWriterLease,
  WRITER_LEASE_FILE,
  type WriterLeaseEnvironment,
} from './writer-lease.ts'

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function threadDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'writer-lease-'))
  dirs.push(dir)
  return dir
}

interface FakeClock {
  at: number
}

function fakeEnv(
  id: string,
  clock: FakeClock,
  options: { host?: string; pid?: number; alive?: (pid: number) => boolean } = {},
): WriterLeaseEnvironment {
  return {
    owner: { id, host: options.host ?? 'host-a', pid: options.pid ?? 100 },
    now: () => clock.at,
    isAlive: options.alive ?? ((): boolean => true),
  }
}

describe('writer lease', () => {
  it('lets one owner hold a thread and reports the holder to the next', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const first = await acquireWriterLease(dir, 't1', fakeEnv('a', clock), 30_000)
    assert.equal(first.status, 'acquired')
    const second = await acquireWriterLease(dir, 't1', fakeEnv('b', clock, { pid: 200 }), 30_000)
    assert.ok(second.status === 'held')
    assert.equal(second.holder.owner, 'a')
  })

  it('renews for the same owner without a new epoch', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const env = fakeEnv('a', clock)
    const first = await acquireWriterLease(dir, 't1', env, 30_000)
    clock.at += 5_000
    const again = await acquireWriterLease(dir, 't1', env, 30_000)
    assert.ok(first.status === 'acquired' && again.status === 'acquired')
    assert.equal(again.lease.epoch, first.lease.epoch)
    assert.equal(again.lease.heartbeatAt, 6_000)
  })

  it('is taken over only once the heartbeat is older than its time-to-live', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const a = fakeEnv('a', clock)
    const b = fakeEnv('b', clock, { pid: 200 })
    const held = await acquireWriterLease(dir, 't1', a, 30_000)
    assert.ok(held.status === 'acquired')

    clock.at += 30_000
    assert.equal((await acquireWriterLease(dir, 't1', b, 30_000)).status, 'held')

    clock.at += 1
    const taken = await acquireWriterLease(dir, 't1', b, 30_000)
    assert.ok(taken.status === 'acquired')
    assert.equal(taken.lease.epoch, held.lease.epoch + 1)

    // The old holder learns it lost the lease and cannot release the new one.
    assert.equal(await renewWriterLease(dir, held.lease, a), false)
    await releaseWriterLease(dir, held.lease, a)
    assert.equal((await readWriterLease(dir, 't1', b))?.owner, 'b')
  })

  it('stays alive while its holder renews it', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const a = fakeEnv('a', clock)
    const held = await acquireWriterLease(dir, 't1', a, 30_000)
    assert.ok(held.status === 'acquired')
    for (let beat = 0; beat < 5; beat += 1) {
      clock.at += 10_000
      assert.equal(await renewWriterLease(dir, held.lease, a), true)
    }
    const b = fakeEnv('b', clock, { pid: 200 })
    assert.equal((await acquireWriterLease(dir, 't1', b, 30_000)).status, 'held')
  })

  it('frees a lease at once when its holder on this host has exited', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    await acquireWriterLease(dir, 't1', fakeEnv('a', clock, { pid: 100 }), 30_000)
    const relaunched = fakeEnv('b', clock, { pid: 200, alive: (pid) => pid !== 100 })
    assert.equal((await acquireWriterLease(dir, 't1', relaunched, 30_000)).status, 'acquired')
  })

  it('does not judge a pid from another host', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    await acquireWriterLease(dir, 't1', fakeEnv('a', clock, { host: 'laptop', pid: 100 }), 30_000)
    const other = fakeEnv('b', clock, { host: 'cloud', pid: 200, alive: () => false })
    assert.equal((await acquireWriterLease(dir, 't1', other, 30_000)).status, 'held')
  })

  it('releases only its own lease', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const a = fakeEnv('a', clock)
    const held = await acquireWriterLease(dir, 't1', a, 30_000)
    assert.ok(held.status === 'acquired')
    await releaseWriterLease(dir, held.lease, a)
    assert.equal(await readWriterLease(dir, 't1', a), null)
    const b = fakeEnv('b', clock, { pid: 200 })
    const next = await acquireWriterLease(dir, 't1', b, 30_000)
    assert.ok(next.status === 'acquired')
    // The epoch never goes back, so a late write from the first holder stays fenced.
    assert.equal(next.lease.epoch, held.lease.epoch + 1)
  })

  it('ignores a lease copied in from another thread', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    await acquireWriterLease(dir, 'source', fakeEnv('a', clock), 30_000)
    const fork = fakeEnv('b', clock, { pid: 200 })
    assert.equal(await readWriterLease(dir, 'fork', fork), null)
    assert.equal((await acquireWriterLease(dir, 'fork', fork, 30_000)).status, 'acquired')
  })

  it('treats an unreadable lease file as free', async () => {
    const dir = await threadDir()
    await writeFile(join(dir, `${WRITER_LEASE_FILE}.1`), '{"v":1,', 'utf8')
    const clock = { at: 1_000 }
    assert.equal(
      (await acquireWriterLease(dir, 't1', fakeEnv('a', clock), 30_000)).status,
      'acquired',
    )
  })

  it('does not let a heartbeat from a clock far ahead hold the thread', async () => {
    const dir = await threadDir()
    await acquireWriterLease(dir, 't1', fakeEnv('a', { at: 1_000_000 }, { host: 'ahead' }), 30_000)
    const local = fakeEnv('b', { at: 1_000 }, { pid: 200 })
    assert.equal((await acquireWriterLease(dir, 't1', local, 30_000)).status, 'acquired')
  })

  it('gives an expired lease to exactly one of several contenders', async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const dir = await threadDir()
      const clock = { at: 1_000 }
      await acquireWriterLease(dir, 't1', fakeEnv('old', clock, { host: 'gone' }), 30_000)
      clock.at += 60_000
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          acquireWriterLease(
            dir,
            't1',
            fakeEnv(`c${String(index)}`, clock, { pid: 200 + index }),
            30_000,
          ),
        ),
      )
      const winners = results.filter((result) => result.status === 'acquired')
      assert.equal(winners.length, 1, `trial ${String(trial)}`)
      assert.equal(winners[0]?.lease.epoch, 2)
    }
  })

  it('tells a lease its holder died with apart from one it released', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    const observer = fakeEnv('app', clock, { pid: 300, alive: (pid) => pid !== 100 })
    const died = await acquireWriterLease(dir, 't1', fakeEnv('worker', clock, { pid: 100 }), 30_000)
    assert.ok(died.status === 'acquired')
    assert.equal(await writerLeaseWasAbandoned(dir, 't1', observer), true)
    const next = fakeEnv('next', clock, { pid: 200, alive: (pid) => pid !== 100 })
    const held = await acquireWriterLease(dir, 't1', next, 30_000)
    assert.ok(held.status === 'acquired')
    assert.equal(await writerLeaseWasAbandoned(dir, 't1', observer), false)
    await releaseWriterLease(dir, held.lease, next)
    assert.equal(await writerLeaseWasAbandoned(dir, 't1', observer), false)
  })

  it('keeps only the newest epoch on disk', async () => {
    const dir = await threadDir()
    const clock = { at: 1_000 }
    for (const id of ['a', 'b', 'c']) {
      const result = await acquireWriterLease(dir, 't1', fakeEnv(id, clock), 30_000)
      assert.ok(result.status === 'acquired')
      await releaseWriterLease(dir, result.lease, fakeEnv(id, clock))
    }
    const names = (await readdir(dir)).filter((name) => name.startsWith(WRITER_LEASE_FILE))
    assert.deepEqual(names, [`${WRITER_LEASE_FILE}.3`])
  })
})

const LEASE_MODULE = pathToFileURL(join(import.meta.dirname, 'writer-lease.ts')).href

/**
 * Each child process takes turns at the lease for a while. Whenever it holds the
 * lease it marks the thread as occupied, checks that nobody else had, waits a
 * little and clears the mark. Two holders at once would find each other's mark.
 */
const CONTENDER = `
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const lease = await import(process.env.LEASE_MODULE)
const dir = process.env.THREAD_DIR
const env = lease.defaultWriterLeaseEnvironment()
const mark = join(dir, 'occupied')
const until = Date.now() + Number(process.env.RUN_MS)
let held = 0
while (Date.now() < until) {
  const result = await lease.acquireWriterLease(dir, 'raced', env, 30_000)
  if (result.status !== 'acquired') { await delay(1); continue }
  held += 1
  const other = await readFile(mark, 'utf8').catch(() => null)
  if (other !== null) await appendFile(join(dir, 'violations'), process.pid + ' found ' + other + '\\n')
  await writeFile(mark, String(process.pid))
  await delay(2)
  await rm(mark, { force: true })
  await lease.releaseWriterLease(dir, result.lease, env)
}
console.log(String(held))
`

function runContender(dir: string, runMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CONTENDER], {
      env: { ...process.env, LEASE_MODULE, THREAD_DIR: dir, RUN_MS: String(runMs) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(Number(out.trim()))
      else reject(new Error(`contender exited ${String(code)}: ${err}`))
    })
  })
}

describe('writer lease across processes', () => {
  it('never lets two processes hold one thread at once', async () => {
    const dir = await threadDir()
    const counts = await Promise.all(Array.from({ length: 4 }, () => runContender(dir, 1_500)))
    const violations = await readFile(join(dir, 'violations'), 'utf8').catch(() => '')
    assert.equal(violations, '')
    assert.ok(
      counts.reduce((sum, count) => sum + count, 0) > 4,
      `the lease changed hands too rarely to test anything: ${counts.join(', ')}`,
    )
  })

  it('is taken over at once after its holder is killed', async () => {
    const dir = await threadDir()
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const lease = await import(process.env.LEASE_MODULE)
const r = await lease.acquireWriterLease(process.env.THREAD_DIR, 'killed')
console.log(r.status)
setInterval(() => {}, 1000)`,
      ],
      {
        env: { ...process.env, LEASE_MODULE, THREAD_DIR: dir },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', (chunk: Buffer) => {
        if (chunk.toString().trim() === 'acquired') resolve()
        else reject(new Error(chunk.toString()))
      })
      holder.once('error', reject)
    })
    const exited = new Promise((resolve) => holder.once('exit', resolve))
    try {
      assert.equal((await acquireWriterLease(dir, 'killed')).status, 'held')
    } finally {
      holder.kill('SIGKILL')
      await exited
    }
    // The time-to-live is 30 s; a dead pid on this host frees the lease now.
    assert.equal((await acquireWriterLease(dir, 'killed')).status, 'acquired')
  })
})
