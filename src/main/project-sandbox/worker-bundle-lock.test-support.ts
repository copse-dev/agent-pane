import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { portBindingWorkerPath } from './spawn.ts'

/**
 * Test files that bundle `port-binding-worker.js` with their own runtime stub
 * all write the one path `portBindingWorkerPath()` names, and the runner runs
 * files in parallel. Each such file holds this lock for its whole run, so one
 * file's bundle is never swapped out under another's spawn.
 *
 * A directory is the lock (`mkdir` is atomic). It records its owner's pid, and a
 * lock whose owner has exited is taken over.
 */
export async function acquireWorkerBundleLock(timeoutMs = 600_000): Promise<() => void> {
  const lock = `${portBindingWorkerPath()}.lock`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      return () => {
        rmSync(lock, { recursive: true, force: true })
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    if (ownerExited(lock)) rmSync(lock, { recursive: true, force: true })
    else if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`)
    else await delay(100)
  }
}

function ownerExited(lock: string): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8'))
  } catch {
    // Created but not yet written: give the owner a moment.
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
