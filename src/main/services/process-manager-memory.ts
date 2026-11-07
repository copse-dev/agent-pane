import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { ProcessManagerRow, ProcessManagerSnapshot } from '@shared/types/process-manager.ts'

const execFileAsync = promisify(execFile)
const MIB = 1024 * 1024
/** The bundled helper emits PID and ri_phys_footprint in bytes. */
export function parseMacosFootprints(output: string): Map<number, number> {
  const footprints = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const bytes = Number(match[2])
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(bytes)) {
      footprints.set(pid, Math.round((bytes / MIB) * 10) / 10)
    }
  }
  return footprints
}

async function readMacosFootprints(pids: readonly number[]): Promise<ReadonlyMap<number, number>> {
  // Unpacked in releases: the OS cannot execute a binary inside app.asar.
  const helper = join(__dirname, '..', 'resources', 'process-memory').replace(
    /([/\\])app\.asar([/\\])/,
    '$1app.asar.unpacked$2',
  )
  const { stdout } = await execFileAsync(helper, pids.map(String), {
    timeout: 1_500,
    maxBuffer: MIB,
  })
  return parseMacosFootprints(stdout)
}

/** Apply one consistent metric to Electron processes and owned subprocesses alike. */
export async function readProcessMemory(
  rows: ProcessManagerRow[],
  platform: NodeJS.Platform = process.platform,
  readFootprints: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, number>> = readMacosFootprints,
): Promise<Pick<ProcessManagerSnapshot, 'processes' | 'memoryMetric'>> {
  if (platform !== 'darwin') return { processes: rows, memoryMetric: 'resident' }
  let footprints: ReadonlyMap<number, number> = new Map()
  if (rows.length > 0) {
    try {
      footprints = await readFootprints([...new Set(rows.map((row) => row.pid))])
    } catch {
      // Exited/inaccessible processes and sampler failures must not masquerade as low RSS.
    }
  }
  return {
    memoryMetric: 'footprint',
    processes: rows.map((row) => ({ ...row, memoryMiB: footprints.get(row.pid) ?? null })),
  }
}
