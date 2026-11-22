// One review at a time per machine. A local review shares the machine's GPU
// (every local model runs on it), its CPU (Stage 0 builds and tests in the
// cell) and one dependency store; two at once would only slow each other and
// race on the store. Agents and hooks that start reviews therefore queue here
// rather than needing to coordinate.
//
// The lock is a directory: `mkdir` is atomic on every filesystem Copse runs
// on. It records its holder's pid, so a holder that died without releasing it
// (killed, or the machine slept through a crash) is noticed and the lock taken
// over instead of waited on forever.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const ownerSchema = z.object({
  pid: z.number().int(),
  startedAt: z.number(),
  label: z.string(),
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
  let waited = false
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      await mkdir(path)
      const owner: ReviewLockOwner = {
        pid: process.pid,
        startedAt: Date.now(),
        label: options.label,
      }
      await writeFile(join(path, 'owner.json'), JSON.stringify(owner))
      let released = false
      return async () => {
        if (released) return
        released = true
        await rm(path, { recursive: true, force: true })
      }
    } catch (err) {
      if (!isErrorWithCode(err, 'EEXIST')) throw err
    }
    const owner = await readFile(join(path, 'owner.json'), 'utf8').then(
      (text) => safeJsonParse(text, decodeOwner),
      () => null,
    )
    // A lock with no readable owner is either being written this instant or
    // was left half-made by a holder that died between the two steps; only
    // the second outlives a minute.
    const abandoned =
      owner === null
        ? await stat(path).then(
            (info) => Date.now() - info.mtimeMs > HALF_MADE_LOCK_MS,
            () => false,
          )
        : !isAlive(owner.pid)
    if (abandoned) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    if (!waited) {
      waited = true
      options.onWait?.(owner)
    }
    await delay(options.pollMs ?? 2_000, undefined, { signal: options.signal })
  }
}
