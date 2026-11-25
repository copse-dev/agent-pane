/**
 * A cross-process mutex held as one file, for work that must not run many at
 * once in a checkout — the post-edit hook's type-aware oxlint run, which builds
 * the whole TypeScript program (~1 GB) and which Copse can dispatch eight at a
 * time per thread.
 *
 * `open(path, 'wx')` is the atomic step: exactly one process creates the file,
 * and it writes its pid there. A waiter that finds the holder's pid dead (a
 * hook killed at its timeout), or the file older than `staleMs` (a pid since
 * reused by an unrelated process), removes it and tries again. Two waiters that
 * reclaim the same stale lock in the same instant can both get through; that
 * costs one extra concurrent run, never a wrong answer, so it is accepted
 * rather than closed with a heavier protocol.
 *
 * Waiting is bounded: past `waitMs` the caller gets `{ ran: false }` and
 * decides what to report, instead of blocking past its own hook timeout.
 */
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type FileLockOptions = {
  /** Give up after waiting this long for another holder. */
  waitMs: number
  /** Treat a lock file older than this as abandoned, whoever holds it. */
  staleMs: number
  /** How often a waiter looks again. */
  pollMs?: number
}

export type FileLockResult<T> = { ran: true; value: T } | { ran: false }

function errorCode(err: unknown): unknown {
  return err instanceof Error && 'code' in err ? err.code : undefined
}

/** True if a process with this pid exists, whether or not we may signal it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

async function tryAcquire(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false
    throw err
  }
  try {
    await handle.writeFile(String(process.pid))
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Whether the current lock file is abandoned. A file with no pid yet is a
 * holder between its create and its write, so only its age can make it stale.
 * A file that vanished meanwhile is not stale: the next acquire will take it.
 */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    if (Date.now() - info.mtimeMs > staleMs) return true
    const pid = Number.parseInt(text, 10)
    return Number.isInteger(pid) && pid > 0 && !isAlive(pid)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false
    throw err
  }
}

/** Remove the lock only while it is still ours, so a reclaimer's lock survives. */
async function release(path: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === String(process.pid)) await rm(path, { force: true })
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
}

/** Run `fn` while holding the lock at `path`, or report that it never got the lock. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: FileLockOptions,
): Promise<FileLockResult<T>> {
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + options.waitMs
  for (;;) {
    if (await tryAcquire(path)) {
      try {
        return { ran: true, value: await fn() }
      } finally {
        await release(path)
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
