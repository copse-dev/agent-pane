/**
 * A cross-process mutex held as one file, for work that must not run many at
 * once in a checkout — the post-edit hook's type-aware oxlint run, which builds
 * the whole TypeScript program (~1 GB) and which Copse can dispatch eight at a
 * time per thread.
 *
 * `open(path, 'wx')` is the atomic step: exactly one process creates the file,
 * and it writes a random token there. While the work runs, the holder touches
 * the file every `heartbeatMs`; a waiter treats a file untouched for `staleMs`
 * as abandoned (a hook killed at its timeout) and removes it. Liveness is the
 * heartbeat, never a pid: Copse runs hooks in a sandbox that, on Linux, gives
 * each one its own PID namespace, where a pid read from the file names some
 * other process — or none — in the waiter's.
 *
 * Release removes the file only while it still holds this holder's token, so a
 * holder whose lock was reclaimed (it stalled past `staleMs`) cannot delete the
 * reclaimer's. Two waiters that reclaim the same stale lock in the same instant
 * can both get through; that costs one extra concurrent run, never a wrong
 * answer, so it is accepted rather than closed with a heavier protocol.
 *
 * Waiting is bounded: past `waitMs` the caller gets `{ ran: false }` and
 * decides what to report, instead of blocking past its own hook timeout.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type FileLockOptions = {
  /** Give up after waiting this long for another holder. */
  waitMs: number
  /** Treat a lock file untouched for this long as abandoned. */
  staleMs: number
  /** How often the holder touches the lock file. Must be well under `staleMs`. */
  heartbeatMs: number
  /** How often a waiter looks again. */
  pollMs?: number
}

export type FileLockResult<T> = { ran: true; value: T } | { ran: false }

function errorCode(err: unknown): unknown {
  return err instanceof Error && 'code' in err ? err.code : undefined
}

/**
 * Whether a failed create means "someone holds it". Windows reports `EPERM`,
 * not `EEXIST`, for a name whose delete is still pending.
 */
function isHeld(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'EEXIST' || (process.platform === 'win32' && code === 'EPERM')
}

async function tryAcquire(path: string, token: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (err) {
    if (isHeld(err)) return false
    throw err
  }
  try {
    await handle.writeFile(token)
  } finally {
    await handle.close()
  }
  return true
}

/** Whether the current lock file has gone unrefreshed for `staleMs`. A vanished file is not stale. */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

/** Remove the lock only while it is still ours, so a reclaimer's lock survives. */
async function release(path: string, token: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === token) await rm(path, { force: true })
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
}

/** Keep the lock fresh while `fn` runs. A failed touch is retried on the next beat. */
function heartbeat(path: string, everyMs: number): () => void {
  const timer = setInterval(() => {
    const now = new Date()
    utimes(path, now, now).catch(() => undefined)
  }, everyMs)
  // The work the lock guards keeps the process alive; the heartbeat must not.
  timer.unref()
  return () => {
    clearInterval(timer)
  }
}

/** Run `fn` while holding the lock at `path`, or report that it never got the lock. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: FileLockOptions,
): Promise<FileLockResult<T>> {
  await mkdir(dirname(path), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + options.waitMs
  for (;;) {
    if (await tryAcquire(path, token)) {
      const stop = heartbeat(path, options.heartbeatMs)
      try {
        return { ran: true, value: await fn() }
      } finally {
        stop()
        await release(path, token)
      }
    }
    if (await isStale(path, options.staleMs)) {
      await rm(path, { force: true })
      continue
    }
    if (Date.now() >= deadline) return { ran: false }
    await sleep(options.pollMs ?? 100)
  }
}
