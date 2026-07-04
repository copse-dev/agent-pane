import type { ChildProcess } from 'node:child_process'

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
 * Send SIGTERM, then SIGKILL the whole process group after a grace period if the
 * child has not exited. Returns a cleanup function that cancels the pending SIGKILL
 * (call it once the process actually closes so the timer never leaks).
 */
export function terminateProcessTree(
  proc: ChildProcess,
  graceMs = SUBPROCESS_KILL_GRACE_MS,
): () => void {
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
