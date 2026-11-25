import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * A fenced, per-thread writer lease (`cross-device-harness-offload.md` O1).
 *
 * Exactly one process may advance a thread's turn. Inside one process the
 * dispatcher's per-thread slot already guarantees that; the store's own mutex
 * (`runSerialized`) is in-process too, so two Copse processes over one profile
 * (a second app, `copse --acp`, a harness worker) had no exclusion at all. This
 * is that exclusion, kept in the thread's own directory as `writer.lease`:
 *
 * - **Owner** names one process: host, pid and a random id minted once per process.
 * - **Epoch** rises by one on every acquisition, so a holder that lost its lease
 *   and later writes can be told apart from the one that took it over (fencing).
 * - **Heartbeat** is renewed while the holder works. A lease whose heartbeat is
 *   older than its time-to-live has expired and may be taken over. On the same
 *   host a holder whose pid is gone has released it at once, so a relaunch after
 *   a crash does not wait for the expiry.
 *
 * Every read-modify-write of the lease file happens inside a short critical
 * section guarded by an atomic `mkdir` of `writer.lease.lock`. A guard left
 * behind by a crash is reclaimed after {@link GUARD_STALE_MS} by renaming it to a
 * unique name first, which only one reclaimer can win.
 *
 * The file records the thread id it belongs to, so a directory copied for a fork
 * or an export never makes the copy look owned.
 */

export const WRITER_LEASE_FILE = 'writer.lease'
const GUARD = `${WRITER_LEASE_FILE}.lock`

/** Whether a thread-relative path is the lease, its guard or a temporary write of either. */
export function isWriterLeasePath(path: string): boolean {
  return path === WRITER_LEASE_FILE || path.startsWith(`${WRITER_LEASE_FILE}.`)
}

/** How long a heartbeat keeps a lease alive. Holders renew at a third of this. */
export const WRITER_LEASE_TTL_MS = 30_000
/** A guard held longer than this belongs to a process that died inside it. */
const GUARD_STALE_MS = 10_000
const GUARD_RETRY_MS = 10
const GUARD_ATTEMPTS = 300

const leaseRecordSchema = z.strictObject({
  v: z.literal(1),
  threadId: z.string().min(1),
  owner: z.string().min(1),
  host: z.string(),
  pid: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
  acquiredAt: z.number(),
  heartbeatAt: z.number(),
  ttlMs: z.number().int().positive(),
})

export type WriterLeaseRecord = z.infer<typeof leaseRecordSchema>

/** One process's identity as a lease owner. */
export interface WriterLeaseOwner {
  id: string
  host: string
  pid: number
}

/** What the lease functions need from the host; injectable so tests can race real processes. */
export interface WriterLeaseEnvironment {
  owner: WriterLeaseOwner
  now: () => number
  /** Whether a pid on this host is still running. */
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, but belongs to another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

let defaultOwner: WriterLeaseOwner | undefined

/** This process's owner identity, minted once so every lease it takes names the same owner. */
export function currentWriterLeaseOwner(): WriterLeaseOwner {
  defaultOwner ??= {
    id: `${hostname()}:${String(process.pid)}:${randomUUID()}`,
    host: hostname(),
    pid: process.pid,
  }
  return defaultOwner
}

export function defaultWriterLeaseEnvironment(): WriterLeaseEnvironment {
  return {
    owner: currentWriterLeaseOwner(),
    now: Date.now,
    isAlive: processIsAlive,
    sleep: async (ms): Promise<void> => {
      await delay(ms)
    },
  }
}

export type WriterLeaseResult =
  | { status: 'acquired'; lease: WriterLeaseRecord }
  | { status: 'held'; holder: WriterLeaseRecord }

async function readRecord(threadDir: string, threadId: string): Promise<WriterLeaseRecord | null> {
  let raw: string
  try {
    raw = await readFile(join(threadDir, WRITER_LEASE_FILE), 'utf8')
  } catch {
    return null
  }
  const record = safeJsonParse(raw, decodeWithSchema(leaseRecordSchema))
  // A lease copied in with the directory belongs to the thread it came from.
  return record?.threadId === threadId ? record : null
}

async function writeRecord(threadDir: string, record: WriterLeaseRecord): Promise<void> {
  const path = join(threadDir, WRITER_LEASE_FILE)
  const tmp = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Whether a record still binds its thread to its owner. */
export function writerLeaseIsLive(
  record: WriterLeaseRecord,
  env: Pick<WriterLeaseEnvironment, 'owner' | 'now' | 'isAlive'>,
): boolean {
  if (env.now() - record.heartbeatAt > record.ttlMs) return false
  // Pids are only meaningful on the host that issued them.
  if (record.host === env.owner.host && !env.isAlive(record.pid)) return false
  return true
}

async function withGuard<T>(
  threadDir: string,
  env: WriterLeaseEnvironment,
  run: () => Promise<T>,
): Promise<T> {
  const guard = join(threadDir, GUARD)
  for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(guard)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      let age: number
      try {
        age = env.now() - (await stat(guard)).mtimeMs
      } catch {
        continue
      }
      if (age > GUARD_STALE_MS) {
        // Rename first: of several reclaimers only one moves the directory.
        const tombstone = `${guard}.stale-${randomUUID()}`
        try {
          await rename(guard, tombstone)
          await rmdir(tombstone)
        } catch {
          // Another process reclaimed or released it first.
        }
        continue
      }
      await env.sleep(GUARD_RETRY_MS)
      continue
    }
    try {
      return await run()
    } finally {
      await rm(guard, { recursive: true, force: true })
    }
  }
  throw new Error(`Timed out waiting for the writer lease guard on ${threadDir}`)
}

/**
 * Take the thread's writer lease, or report who holds it. A process that already
 * holds it renews it and keeps its epoch.
 */
export async function acquireWriterLease(
  threadDir: string,
  threadId: string,
  env: WriterLeaseEnvironment = defaultWriterLeaseEnvironment(),
  ttlMs: number = WRITER_LEASE_TTL_MS,
): Promise<WriterLeaseResult> {
  await mkdir(threadDir, { recursive: true })
  return withGuard(threadDir, env, async (): Promise<WriterLeaseResult> => {
    const current = await readRecord(threadDir, threadId)
    const now = env.now()
    if (current && current.owner === env.owner.id) {
      const renewed = { ...current, heartbeatAt: now, ttlMs }
      await writeRecord(threadDir, renewed)
      return { status: 'acquired', lease: renewed }
    }
    if (current && writerLeaseIsLive(current, env)) return { status: 'held', holder: current }
    const lease: WriterLeaseRecord = {
      v: 1,
      threadId,
      owner: env.owner.id,
      host: env.owner.host,
      pid: env.owner.pid,
      epoch: (current?.epoch ?? 0) + 1,
      acquiredAt: now,
      heartbeatAt: now,
      ttlMs,
    }
    await writeRecord(threadDir, lease)
    return { status: 'acquired', lease }
  })
}

/**
 * Extend a held lease. Returns false when it is no longer ours (it expired and
 * someone took it over), in which case the caller must stop writing.
 */
export async function renewWriterLease(
  threadDir: string,
  lease: WriterLeaseRecord,
  env: WriterLeaseEnvironment = defaultWriterLeaseEnvironment(),
): Promise<boolean> {
  return withGuard(threadDir, env, async () => {
    const current = await readRecord(threadDir, lease.threadId)
    if (current?.owner !== lease.owner || current.epoch !== lease.epoch) return false
    await writeRecord(threadDir, { ...current, heartbeatAt: env.now() })
    return true
  })
}

/** Give the lease up. A lease that already changed hands is left alone. */
export async function releaseWriterLease(
  threadDir: string,
  lease: WriterLeaseRecord,
  env: WriterLeaseEnvironment = defaultWriterLeaseEnvironment(),
): Promise<void> {
  try {
    await withGuard(threadDir, env, async () => {
      const current = await readRecord(threadDir, lease.threadId)
      if (current?.owner !== lease.owner || current.epoch !== lease.epoch) return
      await rm(join(threadDir, WRITER_LEASE_FILE), { force: true })
    })
  } catch {
    // A thread deleted under its own turn has no lease left to release.
  }
}

/** The live holder of a thread's lease, if any, without changing it. */
export async function readWriterLease(
  threadDir: string,
  threadId: string,
  env: Pick<WriterLeaseEnvironment, 'owner' | 'now' | 'isAlive'> = defaultWriterLeaseEnvironment(),
): Promise<WriterLeaseRecord | null> {
  const current = await readRecord(threadDir, threadId)
  return current && writerLeaseIsLive(current, env) ? current : null
}
