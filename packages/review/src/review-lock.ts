// One review at a time per machine. A local review shares the machine's GPU
// (every local model runs on it), its CPU (Stage 0 builds and tests in the
// cell) and one dependency store; two at once would only slow each other and
// race on the store. Agents and hooks that start reviews therefore queue here
// rather than needing to coordinate.
//
// The lock is a directory: `mkdir` is atomic on every filesystem Copse runs
// on. It records its holder's pid, start time and a nonce, so a holder that
// died without releasing it (killed, or the machine rebooted) is noticed and
// the lock taken over instead of waited on forever. Taking over is itself
// serialised by a second directory, so two waiters that both saw the same dead
// holder cannot each remove the lock the other just took; and a release
// removes the lock only while it is still the releaser's own.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const ownerSchema = z.object({
  pid: z.number().int(),
  startedAt: z.number(),
  label: z.string(),
  nonce: z.string().optional(),
})
export type ReviewLockOwner = z.infer<typeof ownerSchema>
const decodeOwner = decodeWithSchema(ownerSchema)

/** How long a lock directory may exist without an owner record before it counts as abandoned. */
const HALF_MADE_LOCK_MS = 60_000

function isErrorWithCode(err: unknown, code: string): boolean {
  return err instanceof Error && Object.hasOwn(err, 'code') && Reflect.get(err, 'code') === code
}

/** Whether a process with `pid` exists on this machine. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists and belongs to someone else.
    return isErrorWithCode(err, 'EPERM')
  }
}

export interface AcquireReviewLockOptions {
  /** What this holder is reviewing, for whoever waits on it. */
  readonly label: string
  readonly signal?: AbortSignal | undefined
  /** Called once, when the lock is first found held by a live process. */
  readonly onWait?: ((owner: ReviewLockOwner | null) => void) | undefined
  readonly pollMs?: number
  readonly isAlive?: (pid: number) => boolean
  /** When this machine last booted (ms since the epoch); a holder from before it is gone. */
  readonly bootedAt?: number
}

async function readOwner(path: string): Promise<ReviewLockOwner | null> {
  return readFile(join(path, 'owner.json'), 'utf8').then(
    (text) => safeJsonParse(text, decodeOwner),
    () => null,
  )
}

async function olderThan(path: string, ms: number): Promise<boolean> {
  return stat(path).then(
    (info) => Date.now() - info.mtimeMs > ms,
    () => false,
  )
}

function sameOwner(a: ReviewLockOwner | null, b: ReviewLockOwner | null): boolean {
  if (a === null || b === null) return a === b
  return a.pid === b.pid && a.startedAt === b.startedAt && a.nonce === b.nonce
}

/**
 * Take the lock at `path`, waiting while another live process holds it.
 * Resolves to the release function; rejects when `signal` aborts first.
 */
export async function acquireReviewLock(
  path: string,
  options: AcquireReviewLockOptions,
): Promise<() => Promise<void>> {
  const isAlive = options.isAlive ?? processAlive
  const bootedAt = options.bootedAt ?? Date.now() - uptime() * 1000
  const nonce = randomBytes(8).toString('hex')
  const takeover = `${path}.takeover`

  // A lock with no readable owner is either being written this instant or was
  // left half-made by a holder that died between the two steps; only the second
  // outlives a minute. A recorded holder is gone when its pid is, or when it
  // started before the machine last booted (its pid may now be someone else's).
  const abandoned = async (owner: ReviewLockOwner | null): Promise<boolean> =>
    owner === null
      ? olderThan(path, HALF_MADE_LOCK_MS)
      : !isAlive(owner.pid) || owner.startedAt < bootedAt

  /** Remove the lock `seen` holds if it is still that one and still abandoned. */
  const takeOver = async (seen: ReviewLockOwner | null): Promise<boolean> => {
    try {
      await mkdir(takeover)
    } catch (err) {
      if (!isErrorWithCode(err, 'EEXIST')) throw err
      if (await olderThan(takeover, HALF_MADE_LOCK_MS)) {
        await rm(takeover, { recursive: true, force: true })
      }
      return false
    }
    try {
      const current = await readOwner(path)
      if (!sameOwner(current, seen) || !(await abandoned(current))) return false
      await rm(path, { recursive: true, force: true })
      return true
    } finally {
      await rm(takeover, { recursive: true, force: true })
    }
  }

  let waited = false
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      await mkdir(path)
      const owner: ReviewLockOwner = {
        pid: process.pid,
        startedAt: Date.now(),
        label: options.label,
        nonce,
      }
      await writeFile(join(path, 'owner.json'), JSON.stringify(owner))
      let released = false
      return async () => {
        if (released) return
        released = true
        // Only our own: a lock another process took over is theirs now.
        if ((await readOwner(path))?.nonce === nonce) {
          await rm(path, { recursive: true, force: true })
        }
      }
    } catch (err) {
      if (!isErrorWithCode(err, 'EEXIST')) throw err
    }
    const owner = await readOwner(path)
    if ((await abandoned(owner)) && (await takeOver(owner))) continue
    if (!waited) {
      waited = true
      options.onWait?.(owner)
    }
    await delay(options.pollMs ?? 2_000, undefined, { signal: options.signal })
  }
}
