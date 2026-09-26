import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ManagedProcessHandle, ProcessManagerRow } from '@shared/types/process-manager.ts'
import { listTerminalProcesses } from './exec/terminal-service.ts'
import { listBackgroundProcessPids } from './exec/background-process.ts'

const execFileAsync = promisify(execFile)

export interface OwnedProcessRoot {
  pid: number
  label: string
  type: 'Terminal' | 'Background task'
  threadId: string | null
  projectId?: string | null
  managed?: ManagedProcessHandle
}

export interface OsProcessSample {
  pid: number
  parentPid: number
  cpuPercent: number
  memoryMiB: number
  command: string
}

/** Parse the process table without trusting process names to have no spaces. */
export function parseProcessTable(output: string): OsProcessSample[] {
  const processes: OsProcessSample[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const cpuPercent = Number(match[3]?.replace(',', '.'))
    const memoryKiB = Number(match[4])
    const command = match[5]
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(parentPid) ||
      !Number.isFinite(cpuPercent) ||
      !Number.isFinite(memoryKiB) ||
      !command
    ) {
      continue
    }
    processes.push({
      pid,
      parentPid,
      cpuPercent: Math.round(Math.max(0, cpuPercent) * 10) / 10,
      memoryMiB: Math.round((memoryKiB / 1024) * 10) / 10,
      command,
    })
  }
  return processes
}

function ownerOf(
  pid: number,
  processes: ReadonlyMap<number, OsProcessSample>,
  roots: ReadonlyMap<number, OwnedProcessRoot>,
): OwnedProcessRoot | null {
  const seen = new Set<number>()
  let current = pid
  while (current > 0 && !seen.has(current) && seen.size < 64) {
    const root = roots.get(current)
    if (root) return root
    seen.add(current)
    current = processes.get(current)?.parentPid ?? 0
  }
  return null
}

/** Include descendants of known Copse tasks, and keep roots visible if OS sampling fails. */
export function ownedProcessRows(
  roots: readonly OwnedProcessRoot[],
  samples: readonly OsProcessSample[],
): ProcessManagerRow[] {
  const byPid = new Map(samples.map((sample) => [sample.pid, sample]))
  const rootByPid = new Map(roots.map((root) => [root.pid, root]))
  const rows: ProcessManagerRow[] = []
  for (const sample of samples) {
    const owner = ownerOf(sample.pid, byPid, rootByPid)
    if (!owner) continue
    const isRoot = sample.pid === owner.pid
    rows.push({
      pid: sample.pid,
      startedAt: 0,
      label: isRoot ? owner.label : basename(sample.command),
      type: isRoot ? owner.type : 'Command',
      threadId: owner.threadId,
      ...(owner.projectId === undefined ? {} : { projectId: owner.projectId }),
      ...(owner.managed === undefined ? {} : { managed: owner.managed }),
      cpuPercent: sample.cpuPercent,
      memoryMiB: sample.memoryMiB,
    })
  }
  for (const root of roots) {
    if (byPid.has(root.pid)) continue
    rows.push({
      pid: root.pid,
      startedAt: 0,
      label: root.label,
      type: root.type,
      threadId: root.threadId,
      ...(root.projectId === undefined ? {} : { projectId: root.projectId }),
      ...(root.managed === undefined ? {} : { managed: root.managed }),
      cpuPercent: null,
      memoryMiB: null,
    })
  }
  return rows
}

/** Read only processes Copse launched for terminals and background work. */
export async function readOwnedProcessRows(managingOwnerId: number): Promise<ProcessManagerRow[]> {
  const roots: OwnedProcessRoot[] = [
    ...listTerminalProcesses().map(
      ({ id, pid, label, threadId, projectId, ownerId }): OwnedProcessRoot => ({
        pid,
        label,
        type: 'Terminal',
        threadId,
        projectId,
        ...(ownerId === managingOwnerId ? { managed: { kind: 'terminal', id } } : {}),
      }),
    ),
    ...listBackgroundProcessPids().map(
      ({ id, pid, command, threadId, projectId }): OwnedProcessRoot => ({
        pid,
        label: command,
        type: 'Background task',
        threadId,
        projectId,
        managed: { kind: 'background', id, projectId, threadId },
      }),
    ),
  ]
  if (roots.length === 0) return []
  if (process.platform === 'win32') return ownedProcessRows(roots, [])
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss=,comm='], {
      timeout: 1_500,
      maxBuffer: 4 * 1024 * 1024,
    })
    return ownedProcessRows(roots, parseProcessTable(stdout))
  } catch {
    return ownedProcessRows(roots, [])
  }
}
