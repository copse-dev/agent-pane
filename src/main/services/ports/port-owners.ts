import { listTerminalProcesses } from '../exec/terminal-service.ts'
import { listBackgroundProcessPids } from '../exec/background-process.ts'
import type { PortOwner } from './process-ancestry.ts'

/** A Copse-spawned process tree root, keyed by the pid ancestry climbs towards. */
export interface OwnedProcess {
  pid: number
  owner: PortOwner
}

/**
 * The pids Copse is responsible for: one per Shells tab and one per running
 * background task. A scanned port is "ours" iff its listener descends from one of
 * these — which is what makes the row killable rather than inert.
 *
 * Kept apart from the exec services themselves so neither of them has to know
 * what a port is; this module is the only place the two are joined.
 */
export function listOwnedProcesses(): OwnedProcess[] {
  const owned: OwnedProcess[] = []
  for (const terminal of listTerminalProcesses()) {
    owned.push({
      pid: terminal.pid,
      owner: { kind: 'terminal', id: terminal.id, label: terminal.label },
    })
  }
  for (const task of listBackgroundProcessPids()) {
    owned.push({
      pid: task.pid,
      owner: { kind: 'background', id: task.id, label: task.command },
    })
  }
  return owned
}

/** Index owned processes by pid, for the ancestry climb in `attributePort`. */
export function ownedByPid(owned: readonly OwnedProcess[]): Map<number, PortOwner> {
  const map = new Map<number, PortOwner>()
  // First writer wins: a terminal and a task cannot share a pid, but a stale
  // duplicate should not silently relabel the row.
  for (const entry of owned) {
    if (!map.has(entry.pid)) map.set(entry.pid, entry.owner)
  }
  return map
}
