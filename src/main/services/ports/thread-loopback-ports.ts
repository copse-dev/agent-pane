import { listBackgroundProcesses } from '../exec/background-process.ts'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'
import { listPortRows, type PortRow } from './ports-registry.ts'

/**
 * The loopback ports a thread's contained shell commands may connect to: those
 * a listener is really bound to, where that listener descends from one of the
 * thread's own running background tasks inside the project sandbox.
 *
 * Each port is checked against the host's port table, never taken from a
 * task's output: a task that prints `http://localhost:5432` must not hand the
 * thread a database it did not start. A task the user let run outside the
 * sandbox may hold a tunnel or proxy to anywhere, so its ports never count.
 */
export function threadServerPorts(
  rows: readonly PortRow[],
  sandboxedTaskIds: ReadonlySet<string>,
): number[] {
  const ports = rows
    .filter((row) => row.owner?.kind === 'background' && sandboxedTaskIds.has(row.owner.id))
    .map((row) => row.port)
  return [...new Set(ports)].sort((a, b) => a - b)
}

export async function threadLoopbackPorts(owner: ThreadExecutionOwner): Promise<number[]> {
  const taskIds = new Set(
    listBackgroundProcesses(owner)
      .filter((task) => task.running && !task.unsandboxed && !task.urlRemote)
      .map((task) => task.id),
  )
  // Most commands run with no server up; skip the host scan entirely then.
  if (taskIds.size === 0) return []
  try {
    const { rows } = await listPortRows()
    return threadServerPorts(rows, taskIds)
  } catch {
    // An unreadable port table grants nothing; the command stays fully contained.
    return []
  }
}
