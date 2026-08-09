import type { ChildProcess } from 'node:child_process'
import { getRemoteProcessMeta } from '../ssh-workspace/remote-process-meta.ts'
import { killRemoteProcessGroup } from './remote-process-kill.ts'

/** Grace period between SIGTERM and the SIGKILL fallback when terminating a subprocess. */
export const SUBPROCESS_KILL_GRACE_MS = 2_000

/**
 * Terminate a child and, where the platform supports it, its whole process group
 * (children spawned via `detached: true` lead a new group whose id is the child pid).
 * Killing the group reaps orphaned grandchildren (e.g. `npm` -> `node`, `bash -c ...`).
 */
function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid
  // On POSIX a detached child leads its own group; negate the pid to target the group.
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Group gone or never detached — fall through to a direct kill.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // Already exited.
  }
}

/**
 * The same group-then-process escalation as {@link signalProcessTree}, for a pid
 * we hold no `ChildProcess` for — a listener discovered by scanning the host
 * rather than one Copse spawned. `-pid` only names a group when that pid leads
 * one, so a non-leader falls through to a direct kill and never reaches a
 * sibling's group.
 */
function signalPidTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Not a group leader — fall through to a direct kill.
    }
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already exited.
  }
}

/** True while the pid exists and this process may signal it. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * SIGTERM a bare pid, escalating to SIGKILL after the grace period if it is still
 * alive. Unlike {@link terminateProcessTree} there is no `ChildProcess` to watch,
 * so liveness is probed with signal 0. The timer is unref'd: a pending escalation
 * must never hold the app open at quit.
 */
export function terminatePidTree(pid: number, graceMs = SUBPROCESS_KILL_GRACE_MS): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  signalPidTree(pid, 'SIGTERM')
  setTimeout(() => {
    if (isPidAlive(pid)) signalPidTree(pid, 'SIGKILL')
  }, graceMs).unref()
}

/**
 * Send SIGTERM, then SIGKILL the whole process group after a grace period if the
 * child has not exited. Returns a cleanup function that cancels the pending SIGKILL
 * (call it once the process actually closes so the timer never leaks).
 */
export function terminateProcessTree(
  proc: ChildProcess,
  graceMs = SUBPROCESS_KILL_GRACE_MS,
): () => void {
  const remote = getRemoteProcessMeta(proc)
  if (remote) {
    void killRemoteProcessGroup(remote.hostId, remote.pgid)
  }
  signalProcessTree(proc, 'SIGTERM')

  // Not unref'd: the timer must fire to guarantee escalation, and the caller always
  // cancels it once the process closes, so it never outlives the subprocess.
  let killTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    killTimer = undefined
    if (proc.exitCode === null && proc.signalCode === null) {
      signalProcessTree(proc, 'SIGKILL')
    }
  }, graceMs)

  return () => {
    if (killTimer) {
      clearTimeout(killTimer)
      killTimer = undefined
    }
  }
}
