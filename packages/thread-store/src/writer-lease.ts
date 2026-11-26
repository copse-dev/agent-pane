import { randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * A fenced, per-thread writer lease (`cross-device-harness-offload.md` O1).
 *
 * Exactly one process may advance a thread's turn. Inside one process the
 * dispatcher's per-thread slot already guarantees that; the store's own mutex
 * (`runSerialized`) is in-process too, so two processes over one profile (a
 * harness worker beside the app, for instance) had no exclusion at all. This is
 * that exclusion, kept in the thread's own directory:
 *
 * - **Owner** names one process: host, pid and a random id minted once per process.
 * - **Epoch** rises by one on every acquisition and never goes back, so a holder
 *   that lost its lease and later writes can be told apart from the one that
 *   took it over (fencing).
 * - **Heartbeat** is renewed while the holder works. A lease whose heartbeat is
 *   older than its time-to-live has expired and may be taken over. On the same
 *   host a holder whose pid is gone has released it at once, so a relaunch after
 *   a crash does not wait for the expiry.
 *
 * Each epoch is its own file, `writer.lease.<epoch>`, and the highest one is the
 * lease. Taking a lease over creates the next epoch's file with an exclusive
 * hard link, which exactly one contender can win; there is no lock to leave
 * behind or reclaim. The holder renews by rewriting its own epoch's file, and
 * learns it lost the lease when a higher epoch exists. Releasing marks the file
 * released rather than deleting it, so the next holder still counts up.
 *
 * The file records the thread id it belongs to, so a directory copied for a fork
 * or an export never makes the copy look owned.
 */

export const WRITER_LEASE_FILE = 'writer.lease'
const EPOCH_FILE = /^writer\.lease\.(\d+)$/

/** Whether a thread-relative path is a lease record or a temporary write of one. */
export function isWriterLeasePath(path: string): boolean {
  return path === WRITER_LEASE_FILE || path.startsWith(`${WRITER_LEASE_FILE}.`)
}

/** How long a heartbeat keeps a lease alive. Holders renew at a third of this. */
export const WRITER_LEASE_TTL_MS = 30_000
/** Contenders that keep losing the race for the next epoch give up after this many tries. */
const TAKEOVER_ATTEMPTS = 50

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
  releasedAt: z.number().optional(),
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
  }
}

export type WriterLeaseResult =
  | { status: 'acquired'; lease: WriterLeaseRecord }
  | { status: 'held'; holder: WriterLeaseRecord }

function epochPath(threadDir: string, epoch: number): string {
  return join(threadDir, `${WRITER_LEASE_FILE}.${String(epoch)}`)
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/**
 * The highest epoch with a record file, or 0 when there is none. Only a
 * missing directory means none: any other failure (EMFILE, EACCES) says
 * nothing about the lease, so it throws rather than read as "taken over".
 */
async function highestEpoch(threadDir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(threadDir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0
    throw error
  }
  let highest = 0
  for (const name of names) {
    const match = EPOCH_FILE.exec(name)
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

async function readEpoch(
  threadDir: string,
  threadId: string,
  epoch: number,
): Promise<WriterLeaseRecord | null> {
  let raw: string
  try {
    raw = await readFile(epochPath(threadDir, epoch), 'utf8')
  } catch (error) {
    // Gone: a racing prune removed it. Anything else (EMFILE, EIO) says
    // nothing about the holder, so it must not read as a free lease.
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  const record = safeJsonParse(raw, decodeWithSchema(leaseRecordSchema))
  // A lease copied in with the directory belongs to the thread it came from.
  return record?.threadId === threadId && record.epoch === epoch ? record : null
}

async function writeTemporary(threadDir: string, record: WriterLeaseRecord): Promise<string> {
  const tmp = join(threadDir, `${WRITER_LEASE_FILE}.${String(process.pid)}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return tmp
}

/** Replace an epoch's record that this owner already holds. */
async function rewriteEpoch(threadDir: string, record: WriterLeaseRecord): Promise<void> {
  const tmp = await writeTemporary(threadDir, record)
  try {
    await rename(tmp, epochPath(threadDir, record.epoch))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Create an epoch's record, complete, only if nobody has. The hard link fails
 * when the name exists, so of several contenders for one epoch exactly one wins.
 */
async function createEpoch(threadDir: string, record: WriterLeaseRecord): Promise<boolean> {
  const tmp = await writeTemporary(threadDir, record)
  try {
    await link(tmp, epochPath(threadDir, record.epoch))
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Remove the records of epochs below `epoch`; the highest one is all that counts. */
async function pruneBelow(threadDir: string, epoch: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(threadDir)
  } catch {
    return
  }
  await Promise.all(
    names.map(async (name) => {
      const match = EPOCH_FILE.exec(name)
      if (match?.[1] === undefined || Number(match[1]) >= epoch) return
      await rm(join(threadDir, name), { force: true }).catch(() => undefined)
    }),
  )
}

/** Whether a record still binds its thread to its owner. */
export function writerLeaseIsLive(
  record: WriterLeaseRecord,
  env: Pick<WriterLeaseEnvironment, 'owner' | 'now' | 'isAlive'>,
): boolean {
  if (record.releasedAt !== undefined) return false
  const age = env.now() - record.heartbeatAt
  if (age > record.ttlMs) return false
  // A heartbeat from further ahead than a whole time-to-live came from a clock
  // that cannot be trusted; it must not hold the thread until ours catches up.
  if (age < -record.ttlMs) return false
  // Pids are only meaningful on the host that issued them.
  if (record.host === env.owner.host && !env.isAlive(record.pid)) return false
  return true
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
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    const epoch = await highestEpoch(threadDir)
    const current = epoch > 0 ? await readEpoch(threadDir, threadId, epoch) : null
    const now = env.now()
    if (current?.owner === env.owner.id && current.releasedAt === undefined) {
      const renewed = { ...current, heartbeatAt: now, ttlMs }
      await rewriteEpoch(threadDir, renewed)
      // Taken over between the read and the rewrite: the lease is no longer ours.
      if ((await highestEpoch(threadDir)) !== epoch) continue
      return { status: 'acquired', lease: renewed }
    }
    if (current && writerLeaseIsLive(current, env)) return { status: 'held', holder: current }
    const lease: WriterLeaseRecord = {
      v: 1,
      threadId,
      owner: env.owner.id,
      host: env.owner.host,
      pid: env.owner.pid,
      epoch: epoch + 1,
      acquiredAt: now,
      heartbeatAt: now,
      ttlMs,
    }
    if (await createEpoch(threadDir, lease)) {
      // An epoch already pruned can be created again by a contender that read
      // the directory long ago; a higher epoch on disk means it lost the race.
      if ((await highestEpoch(threadDir)) !== lease.epoch) continue
      await pruneBelow(threadDir, lease.epoch)
      return { status: 'acquired', lease }
    }
    // Another contender took this epoch first; look again.
  }
  throw new Error(`Could not settle the writer lease on ${threadDir}`)
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
  if ((await highestEpoch(threadDir)) !== lease.epoch) return false
  const current = await readEpoch(threadDir, lease.threadId, lease.epoch)
  if (current?.owner !== lease.owner || current.releasedAt !== undefined) return false
  await rewriteEpoch(threadDir, { ...current, heartbeatAt: env.now() })
  return (await highestEpoch(threadDir)) === lease.epoch
}

/** Give the lease up. A lease that already changed hands is left alone. */
export async function releaseWriterLease(
  threadDir: string,
  lease: WriterLeaseRecord,
  env: WriterLeaseEnvironment = defaultWriterLeaseEnvironment(),
): Promise<void> {
  try {
    if ((await highestEpoch(threadDir)) !== lease.epoch) return
    const current = await readEpoch(threadDir, lease.threadId, lease.epoch)
    if (current?.owner !== lease.owner || current.releasedAt !== undefined) return
    // Kept, marked released, so the next holder's epoch still counts up from it.
    await rewriteEpoch(threadDir, { ...current, releasedAt: env.now() })
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
  const epoch = await highestEpoch(threadDir)
  const current = epoch > 0 ? await readEpoch(threadDir, threadId, epoch) : null
  return current && writerLeaseIsLive(current, env) ? current : null
}
