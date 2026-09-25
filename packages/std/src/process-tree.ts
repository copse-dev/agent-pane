import type { ChildProcess } from 'node:child_process'

/**
 * Signal a child and, where the platform supports it, its whole process group.
 * A child spawned with `detached: true` leads a new group whose id is its pid,
 * so negating the pid also reaches orphaned grandchildren (`npm` -> `node`,
 * `bash -c ...`). A child that leads no group, and every child on Windows,
 * falls back to a direct signal. A process that has already exited is ignored.
 */
export function signalProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Group gone or never detached — fall through to a direct kill.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already exited.
  }
}
