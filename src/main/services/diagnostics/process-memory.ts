import { execFile } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { ProcessManagerSnapshot } from '@shared/types/process-manager.ts'

const execFileAsync = promisify(execFile)
const SAMPLE_LIMIT = 120
const SHUTDOWN_LIMIT = 32
const INTERVAL_MS = 15_000

/** Deliberately excludes commands, labels, paths, arguments and environment. */
interface MemoryPoint {
  sampledAt: number
  processCount: number
  measuredProcessCount: number
  memoryMiB: number
  sharedMemoryMiB: number
  threadCount: number
  largest: { pid: number; memoryMiB: number; threadId: string | null }[]
}

interface ShutdownPoint {
  sampledAt: number
  rootPid: number
  status: 'sampled' | 'unavailable'
  survivors: { pid: number; memoryMiB: number }[]
}

export function summarizeProcessMemory(snapshot: ProcessManagerSnapshot): MemoryPoint {
  const rows = [...new Map(snapshot.processes.map((row) => [row.pid, row])).values()]
  const measured = rows.filter((row) => row.memoryMiB !== null && Number.isFinite(row.memoryMiB))
  return {
    sampledAt: snapshot.sampledAt,
    processCount: rows.length,
    measuredProcessCount: measured.length,
    memoryMiB: measured.reduce((sum, row) => sum + Math.max(0, row.memoryMiB ?? 0), 0),
    sharedMemoryMiB: measured.reduce(
      (sum, row) => sum + (row.threadId === null ? Math.max(0, row.memoryMiB ?? 0) : 0),
      0,
    ),
    threadCount: new Set(rows.flatMap((row) => (row.threadId === null ? [] : [row.threadId]))).size,
    largest: measured
      .sort((a, b) => (b.memoryMiB ?? 0) - (a.memoryMiB ?? 0))
      .slice(0, 20)
      .map((row) => ({ pid: row.pid, memoryMiB: row.memoryMiB ?? 0, threadId: row.threadId })),
  }
}

/** Group members remain observable after their parent exits/reparenting occurs. */
export function parseShutdownGroup(output: string, rootPid: number): ShutdownPoint['survivors'] {
  return output
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
      if (!match || Number(match[2]) !== rootPid || match[4]?.startsWith('Z')) return []
      return [{ pid: Number(match[1]), memoryMiB: Number(match[3]) / 1024 }]
    })
    .slice(0, 100)
}

/** Bounded rolling report, replaced atomically; no append-only diagnostic log. */
export class ProcessMemoryHistory {
  readonly samples: MemoryPoint[] = []
  readonly shutdowns: ShutdownPoint[] = []

  record(snapshot: ProcessManagerSnapshot): void {
    const last = this.samples.at(-1)
    if (last && snapshot.sampledAt - last.sampledAt < INTERVAL_MS) return
    this.samples.push(summarizeProcessMemory(snapshot))
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift()
  }

  shutdown(point: ShutdownPoint): void {
    this.shutdowns.push(point)
    if (this.shutdowns.length > SHUTDOWN_LIMIT) this.shutdowns.shift()
  }
}

const history = new ProcessMemoryHistory()
const outputPath = process.env['COPSE_DEBUG_PROCESS_MEMORY_OUT']
let samplingStarted = false
let writing = false
let dirty = false

async function persist(): Promise<void> {
  if (!outputPath) return
  dirty = true
  if (writing) return
  writing = true
  try {
    await mkdir(dirname(outputPath), { recursive: true })
    while (dirty) {
      dirty = false
      const temporary = `${outputPath}.tmp`
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, samples: history.samples, shutdowns: history.shutdowns }),
        { mode: 0o600 },
      )
      await rename(temporary, outputPath)
    }
  } catch {
    // Diagnostics must never prevent sampling or subprocess shutdown.
  } finally {
    writing = false
  }
}

/** Enable by setting COPSE_DEBUG_PROCESS_MEMORY_OUT to a report file at launch. */
export function startProcessMemoryDiagnostics(sample: () => Promise<ProcessManagerSnapshot>): void {
  if (!outputPath || samplingStarted) return
  samplingStarted = true
  let pending = false
  const tick = async (): Promise<void> => {
    if (pending) return
    pending = true
    try {
      history.record(await sample())
      await persist()
    } catch {
      // An unavailable platform sampler does not break the application.
    } finally {
      pending = false
    }
  }
  setInterval(() => {
    void tick()
  }, INTERVAL_MS).unref()
  void tick()
}

let pendingShutdowns = 0

/** Main sampler only: workers inherit the flag but must never create their own reports.
 * Observation only, never kills a PID. Escaped process groups cannot be detected. */
export function observeProcessShutdown(pid: number | undefined, delayMs: number): void {
  if (
    !outputPath ||
    !samplingStarted ||
    process.platform === 'win32' ||
    pid === undefined ||
    pid <= 1 ||
    pendingShutdowns >= SHUTDOWN_LIMIT
  )
    return
  pendingShutdowns++
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,pgid=,rss=,stat='], {
          timeout: 1_500,
          maxBuffer: 4 * 1024 * 1024,
        })
        history.shutdown({
          sampledAt: Date.now(),
          rootPid: pid,
          status: 'sampled',
          survivors: parseShutdownGroup(stdout, pid),
        })
      } catch {
        history.shutdown({
          sampledAt: Date.now(),
          rootPid: pid,
          status: 'unavailable',
          survivors: [],
        })
      } finally {
        pendingShutdowns--
      }
      await persist()
    })()
  }, delayMs).unref()
}
