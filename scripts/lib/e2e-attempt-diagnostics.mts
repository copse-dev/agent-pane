import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import type { SpawnSyncReturns } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

export const E2E_ATTEMPT_DIRECTORY_ENV = 'COPSE_E2E_DIAGNOSTICS_DIR'
const attemptName = /^attempt-(?:[1-9]\d*|unknown)-[a-zA-Z0-9]+$/
const pidSchema = z.number().int().positive().max(2_147_483_647).optional().catch(undefined)
const capabilityPids = z.object({ 'wdio:driverPID': pidSchema, 'goog:processID': pidSchema })
const errorCode = z.object({ code: z.string().optional().catch(undefined) })

function logsRoot(root: string): string {
  return resolve(root, 'e2e-failure-artifacts', 'wdio-logs')
}

function writeFact(directory: string, name: string, fact: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(fact) + '\n', { flag: 'wx' })
}

/** Only this runner's generated directories, never an arbitrary environment path. */
export function managedAttemptDirectory(
  value: string | undefined,
  root = process.cwd(),
): string | undefined {
  if (!value) return undefined
  const directory = resolve(value)
  if (dirname(directory) !== logsRoot(root) || !attemptName.test(basename(directory)))
    return undefined
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      return undefined
    return directory
  } catch {
    return undefined
  }
}

/** Each invocation gets a new directory even when an outer attempt number repeats. */
export function startAttemptArtifacts(
  attempt: string | undefined,
  root = process.cwd(),
): string | undefined {
  try {
    const number = attempt && /^[1-9]\d{0,5}$/.test(attempt) ? Number(attempt) : null
    mkdirSync(logsRoot(root), { recursive: true })
    const directory = mkdtempSync(join(logsRoot(root), `attempt-${String(number ?? 'unknown')}-`))
    writeFact(directory, 'attempt-start.json', {
      version: 1,
      capturedAt: new Date().toISOString(),
      attempt: number,
      driverExitCode: null,
      driverSignal: null,
      driverCrash: 'unknown: managed WebDriver does not expose its child lifecycle',
      electronChildLifecycle: 'unknown: not exposed by negotiated capabilities',
    })
    return directory
  } catch {
    console.warn('Unable to create e2e attempt diagnostics')
    return undefined
  }
}

export function driverLogDirectory(): string {
  return managedAttemptDirectory(process.env[E2E_ATTEMPT_DIRECTORY_ENV]) ?? logsRoot(process.cwd())
}

export function recordLaunchResult(
  directory: string,
  command: 'wdio' | 'xvfb-run',
  result: Pick<SpawnSyncReturns<Buffer>, 'pid' | 'status' | 'signal' | 'error'>,
): void {
  try {
    const error = errorCode.safeParse(result.error)
    writeFact(directory, 'launch-command-result.json', {
      capturedAt: new Date().toISOString(),
      role: 'launch-command',
      command,
      pid: result.pid || null,
      exitCode: result.status,
      signal: result.signal,
      spawnErrorCode: error.success ? (error.data.code?.slice(0, 64) ?? null) : null,
      qualification: 'This is the launch command, not the managed driver or Electron exit cause.',
    })
  } catch {
    console.warn('Unable to record e2e launch result')
  }
}

type PidObservation = 'exists' | 'absent' | 'permission-denied' | 'unknown'

export function observePid(pid: number): PidObservation {
  try {
    process.kill(pid, 0)
    return 'exists'
  } catch (error) {
    const parsed = errorCode.safeParse(error)
    if (parsed.success && parsed.data.code === 'ESRCH') return 'absent'
    if (parsed.success && parsed.data.code === 'EPERM') return 'permission-denied'
    return 'unknown'
  }
}

export function sessionLifecycleFact(
  phase: 'session-ready' | 'before-forced-cleanup',
  capabilities: unknown,
  probe: (pid: number) => PidObservation = observePid,
): object {
  const parsed = capabilityPids.safeParse(capabilities)
  const pids = parsed.success ? parsed.data : {}
  const observe = (
    pid: number | undefined,
  ): { pid: number | null; observation: PidObservation } => ({
    pid: pid ?? null,
    observation: pid === undefined ? 'unknown' : probe(pid),
  })
  return {
    capturedAt: new Date().toISOString(),
    phase,
    driver: observe(pids['wdio:driverPID']),
    electronMain: observe(pids['goog:processID']),
    driverExitCode: null,
    driverSignal: null,
    electronChildLifecycle: 'unknown',
    qualification:
      'PID existence is not health, identity, crash cause, or evidence of initiating death.',
  }
}

let sessionFactsWritten = 0

/** No WebDriver traffic: capture before the existing cleanup can change process state. */
export function recordSessionLifecycle(
  phase: 'session-ready' | 'before-forced-cleanup',
  readCapabilities: () => unknown,
): void {
  const directory = managedAttemptDirectory(process.env[E2E_ATTEMPT_DIRECTORY_ENV])
  if (!directory || sessionFactsWritten > 64) return
  try {
    const fact =
      sessionFactsWritten === 64
        ? { capturedAt: new Date().toISOString(), truncated: true, reason: 'worker fact limit' }
        : sessionLifecycleFact(phase, readCapabilities())
    appendFileSync(
      join(directory, `session-${String(process.pid)}.jsonl`),
      JSON.stringify(fact) + '\n',
    )
    sessionFactsWritten++
  } catch {
    console.warn('Unable to record e2e session lifecycle')
  }
}

export function recordWorkerEnd(
  cid: string,
  exitCode: number,
  signal: string | null | undefined,
): void {
  const directory = managedAttemptDirectory(process.env[E2E_ATTEMPT_DIRECTORY_ENV])
  if (!directory) return
  try {
    const safeCid = cid.replace(/[^\w-]/g, '_').slice(0, 64)
    writeFact(directory, `worker-${safeCid}.json`, {
      capturedAt: new Date().toISOString(),
      role: 'wdio-worker',
      worker: safeCid,
      exitCode,
      signal: signal && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null,
      qualification: 'Worker exit is separate from driver and Electron lifecycle.',
    })
  } catch {
    console.warn('Unable to record e2e worker result')
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    const data: unknown = chunk
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) throw new Error('Unexpected log bytes')
    hash.update(data)
  }
  return hash.digest('hex')
}

/**
 * Seal byte snapshots before another attempt/cleanup. A driver may still be
 * writing its original log: neither runner completion nor this snapshot proves EOF.
 */
export async function sealAttemptArtifacts(
  directory: string,
  outerExitStatus?: number,
  root = process.cwd(),
): Promise<void> {
  if (!managedAttemptDirectory(directory, root)) return
  try {
    if (
      outerExitStatus !== undefined &&
      !existsSync(join(directory, 'outer-attempt-result.json'))
    ) {
      writeFact(directory, 'outer-attempt-result.json', {
        capturedAt: new Date().toISOString(),
        role: 'outer-attempt',
        exitStatus: outerExitStatus,
        qualification: 'Shell pipeline status is not an observed driver exit code or signal.',
      })
    }
    if (existsSync(join(directory, 'snapshot'))) return
    const staging = mkdtempSync(join(directory, '.snapshot-'))
    const files: { name: string; bytes: number; sha256: string }[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:log|json|jsonl)$/.test(entry.name)) continue
      const retained = join(staging, entry.name)
      copyFileSync(join(directory, entry.name), retained, constants.COPYFILE_EXCL)
      files.push({
        name: entry.name,
        bytes: statSync(retained).size,
        sha256: await sha256(retained),
      })
    }
    writeFact(staging, 'manifest.json', {
      version: 1,
      capturedAt: new Date().toISOString(),
      capturePoint:
        outerExitStatus === undefined
          ? 'launch-command-returned'
          : 'outer-attempt-returned-before-workflow-cleanup',
      driverEof: 'unknown',
      driverExitCode: null,
      driverSignal: null,
      launchResultAvailable: existsSync(join(directory, 'launch-command-result.json')),
      files,
    })
    renameSync(staging, join(directory, 'snapshot'))
  } catch {
    // Original logs and any partial staging survive; diagnostics never replace the test result.
    console.warn('Unable to seal e2e attempt diagnostics')
  }
}
