import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ManagedProcessHandle, ProcessManagerRow } from '@shared/types/process-manager.ts'
import { listTerminalProcesses } from './exec/terminal-service.ts'
import { listBackgroundProcessPids } from './exec/background-process.ts'
import { gortexDaemonPidPath } from './search/semantic-index.ts'

const execFileAsync = promisify(execFile)

export interface OwnedProcessRoot {
  pid: number
  label: string
  type: 'Terminal' | 'Background task' | 'Indexer' | 'Subprocess'
  threadId: string | null
  projectId?: string | null
  managed?: ManagedProcessHandle
  /**
   * The executable name a live sample must have. Set for pids read from a pid
   * file, which can outlive their process; such a root is dropped rather than
   * shown when it is not sampled or the pid now belongs to something else.
   */
  command?: string
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
  const rootByPid = new Map(
    roots
      .filter(
        (root) =>
          root.command === undefined ||
          basename(byPid.get(root.pid)?.command ?? '') === root.command,
      )
      .map((root) => [root.pid, root]),
  )
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
    if (byPid.has(root.pid) || root.command !== undefined) continue
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

/**
 * Copse's own non-Electron children — agent CLIs, MCP and language servers,
 * short-lived git or search commands — that no terminal or task already owns.
 */
export function copseChildRoots(
  samples: readonly OsProcessSample[],
  mainPid: number,
  appPids: ReadonlySet<number>,
  claimedPids: ReadonlySet<number>,
): OwnedProcessRoot[] {
  return samples
    .filter(
      (sample) =>
        sample.parentPid === mainPid && !appPids.has(sample.pid) && !claimedPids.has(sample.pid),
    )
    .map((sample) => ({
      pid: sample.pid,
      label: basename(sample.command),
      type: 'Subprocess',
      threadId: null,
    }))
}

/** Friendly names for the worker scripts Copse runs as `<execPath> <worker>.js`. */
const SELF_WORKER_LABELS = new Map([
  ['acp-session-host-worker', 'Agent session host'],
  ['acp-probe-worker', 'Agent probe'],
  ['sandbox-fs-worker', 'Sandbox file server'],
  ['plugin-tool-worker', 'Plugin tool host'],
])

/** Name a Copse-as-Node child from its command line; the executable alone reads "Electron". */
export function selfHelperLabel(args: string): string {
  const script = /([^/\s]+)\.[cm]?js(?:\s|$)/.exec(args)?.[1]
  if (!script) return 'Copse helper'
  return SELF_WORKER_LABELS.get(script) ?? script
}

/** Parse `ps -o pid=,args=` output into full command lines by pid. */
export function parseProcessArgs(output: string): Map<number, string> {
  const argsByPid = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match?.[1] && match[2]) argsByPid.set(Number(match[1]), match[2])
  }
  return argsByPid
}

async function labelSelfHelpers(roots: readonly OwnedProcessRoot[]): Promise<OwnedProcessRoot[]> {
  const self = basename(process.execPath)
  const pids = roots.filter((root) => root.label === self).map((root) => root.pid)
  if (pids.length === 0) return [...roots]
  let argsByPid = new Map<number, string>()
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,args=', '-p', pids.join(',')], {
      timeout: 1_500,
      maxBuffer: 1024 * 1024,
    })
    argsByPid = parseProcessArgs(stdout)
  } catch {
    // `ps -p` exits non-zero when a helper exited between samples.
  }
  return roots.map((root) =>
    root.label === self ? { ...root, label: selfHelperLabel(argsByPid.get(root.pid) ?? '') } : root,
  )
}

async function readGortexDaemonRoot(): Promise<OwnedProcessRoot | null> {
  try {
    const pid = Number((await readFile(gortexDaemonPidPath(), 'utf8')).trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    return { pid, label: 'gortex daemon', type: 'Indexer', threadId: null, command: 'gortex' }
  } catch {
    return null
  }
}

/**
 * Read processes Copse launched: terminals and background work (with their
 * descendants), the detached gortex code-index daemon, and other direct
 * children of the main process that are not Electron's own (`appPids`).
 */
export async function readOwnedProcessRows(
  managingOwnerId: number,
  appPids: ReadonlySet<number>,
): Promise<ProcessManagerRow[]> {
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
  if (process.platform === 'win32') return ownedProcessRows(roots, [])
  const gortex = await readGortexDaemonRoot()
  if (gortex) roots.push(gortex)
  try {
    const table = execFileAsync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss=,comm='], {
      timeout: 1_500,
      maxBuffer: 4 * 1024 * 1024,
    })
    const { stdout } = await table
    const samples = parseProcessTable(stdout)
    // The sampling `ps` is itself a child of main; don't report it.
    const claimed = new Set([...roots.map((root) => root.pid), table.child.pid ?? 0])
    const helpers = await labelSelfHelpers(copseChildRoots(samples, process.pid, appPids, claimed))
    return ownedProcessRows([...roots, ...helpers], samples)
  } catch {
    return ownedProcessRows(roots, [])
  }
}
