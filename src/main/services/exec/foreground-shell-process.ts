import { errorMessage } from '@shared/errors.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:os'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  newSandboxViolationId,
  sandboxViolationCountForRun,
  spawnShellInProjectSandbox,
} from '../../project-sandbox/index.ts'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_MAX_BYTES,
  stripTerminalControlSequences,
} from './subprocess-output-cap.ts'
import { terminateProcessTree } from './subprocess-kill.ts'
import { emitShellOutput } from './shell-output-context.ts'
import { adoptSupervisedBackgroundProcess } from './supervised-background-process.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'

/** Tells the model how to reach output dropped from the middle of an over-cap run. */
const RUN_SHELL_TRUNCATION_HINT =
  'Re-run with a narrower command (grep -n, sed -n, head/tail, or redirect to a file) to see the dropped part.'

/** Steers a timed-out run toward the background path instead of a blind rerun. */
const RUN_SHELL_TIMEOUT_HINT =
  'For long builds, test suites, or other slow work, use run_background with wake_on_completion instead of rerunning in the foreground.'

/** Keep what the command printed before the deadline so the model is not left rerunning it blind. */
function timeoutError(timeoutMs: number, output: string): Error {
  const clean = stripTerminalControlSequences(output).trim()
  const captured = clean ? `Output before the timeout:\n${clean}` : '(no output before the timeout)'
  return new Error(
    `Command timed out after ${String(timeoutMs)}ms.\n${captured}\n\n${RUN_SHELL_TIMEOUT_HINT}`,
  )
}

/** Shell convention for a signal death (128 + signal number), so it never reads as success. */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return signal ? 128 + constants.signals[signal] : 1
}

export interface ShellRunResult {
  output: string
  exitCode: number
  sandboxViolationCount?: number
  backgroundId?: string
  /** The sandbox wrapper process itself failed to start (child 'error' event). */
  spawnFailed?: boolean
}

/** A running run_shell command, for attributing it back to the thread that ran it. */
export interface ForegroundShellProcess {
  pid: number
  command: string
  threadId: string
  projectId: string
}

// Unlike background tasks these have no id or handle: they end with the tool
// call. The Process Manager needs them anyway, because they run as direct
// children of main and would otherwise read as Shared.
const liveForegroundShells = new Set<ForegroundShellProcess>()

/** Every running run_shell command across threads; detached ones move to the background registry. */
export function listForegroundShellProcesses(): ForegroundShellProcess[] {
  return [...liveForegroundShells]
}

export async function runShellOnce(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  unsandboxed: boolean,
  env: NodeJS.ProcessEnv,
  readGrantTargets: readonly string[] = [],
  onDetach?: () => () => Promise<void>,
  readonlyCheckout = false,
): Promise<ShellRunResult> {
  signal.throwIfAborted()
  const owner = getThreadExecutionContext()
  return new Promise<ShellRunResult>((resolve, reject) => {
    void (async (): Promise<void> => {
      const spawnController = new AbortController()
      const cancelSpawn = (): void => {
        if (signal.reason !== 'send_now') spawnController.abort(signal.reason)
      }
      signal.addEventListener('abort', cancelSpawn, { once: true })
      // Attribute violations to this run alone, not to every run of the same text.
      const violationId = newSandboxViolationId()
      let proc
      try {
        proc = await spawnShellInProjectSandbox(command, {
          cwd,
          env,
          // Nothing writes to the child's stdin, so a command that reads it
          // (`read`, a confirmation prompt, an editor) gets EOF instead of
          // hanging until the timeout.
          stdio: ['ignore', 'pipe', 'pipe'],
          unsandboxed,
          violationId,
          readGrantTargets,
          ...(readonlyCheckout ? { readonlyCheckout } : {}),
          signal: spawnController.signal,
        })
      } catch (err) {
        // Wrapping the command in the sandbox failed (runner-side, not command
        // output). For a sandboxed run, surface it as spawnFailed so an unsandboxed
        // retry can be offered (issue #104); for an unsandboxed run it's a real error.
        if (!unsandboxed) {
          const message = errorMessage(err)
          resolve({ output: message, exitCode: -1, spawnFailed: true })
        } else {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        return
      } finally {
        signal.removeEventListener('abort', cancelSpawn)
      }

      const live =
        owner && proc.pid !== undefined && proc.pid > 0
          ? { pid: proc.pid, command, threadId: owner.threadId, projectId: owner.projectId }
          : null
      if (live) liveForegroundShells.add(live)

      const startedAt = Date.now()
      const ranUnsandboxed = unsandboxed || !isProjectSandboxEnabled()
      const outputAcc = new CappedOutputAccumulator(COMMAND_OUTPUT_MAX_BYTES, {
        evidence: true,
        hint: RUN_SHELL_TRUNCATION_HINT,
      })
      let settled = false
      let detached = false
      let releaseDetached: (() => Promise<void>) | undefined
      let cancelKill: (() => void) | undefined
      const stream = (data: Buffer): void => {
        const toStream = outputAcc.append(data.toString())
        if (toStream) emitShellOutput(toStream)
      }
      proc.stdout?.on('data', stream)
      proc.stderr?.on('data', stream)

      const onAbort = AsyncLocalStorage.bind((): void => {
        if (detached) return
        if (signal.reason === 'send_now' && owner) {
          detached = true
          settled = true
          cleanup()
          proc.stdout?.removeListener('data', stream)
          proc.stderr?.removeListener('data', stream)
          releaseDetached = onDetach?.()
          void adoptSupervisedBackgroundProcess({
            command,
            cwd,
            proc,
            owner,
            unsandboxed: ranUnsandboxed,
            startedAt,
            output: outputAcc.toString(),
            timeoutMs: Math.max(1, timeout_ms - (Date.now() - startedAt)),
          }).then(
            (info) => {
              resolve({ output: outputAcc.toString(), exitCode: 0, backgroundId: info.id })
            },
            (error: unknown) => {
              cancelKill = terminateProcessTree(proc)
              reject(error instanceof Error ? error : new Error(String(error)))
            },
          )
          return
        }
        clearTimeout(timer)
        cancelKill = terminateProcessTree(proc)
      })

      const cleanup = (): void => {
        if (live) liveForegroundShells.delete(live)
        clearTimeout(timer)
        cancelKill?.()
        signal.removeEventListener('abort', onAbort)
      }

      const timer = setTimeout(() => {
        cancelKill = terminateProcessTree(proc)
        if (!settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(timeoutError(timeout_ms, outputAcc.toString()))
        }
      }, timeout_ms)

      const sandboxViolationCount = (): number =>
        unsandboxed ? 0 : sandboxViolationCountForRun(violationId)

      const finish = (): void => {
        if (!unsandboxed) afterSandboxedCommand()
        if (releaseDetached) {
          const release = releaseDetached
          releaseDetached = undefined
          void release().catch((error: unknown) => {
            console.warn('[foreground-shell-process] cleanup failed:', error)
          })
        }
      }

      proc.on('error', (err) => {
        cleanup()
        const violationCount = sandboxViolationCount()
        finish()
        if (settled) return
        settled = true
        // A child 'error' (e.g. the sandbox wrapper binary failed to launch) is a
        // runner-side failure, not command-controlled output. Surface it as a result
        // with spawnFailed so an unsandboxed retry can be offered (issue #104), but
        // only when this was a sandboxed run.
        if (!unsandboxed) {
          const message = errorMessage(err)
          resolve({
            output: message,
            exitCode: -1,
            sandboxViolationCount: violationCount,
            spawnFailed: true,
          })
          return
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      })

      proc.on('close', (code, closeSignal) => {
        cleanup()
        const violationCount = sandboxViolationCount()
        finish()
        if (settled) return
        settled = true
        resolve({
          output: outputAcc.toString(),
          exitCode: exitCodeFor(code, closeSignal),
          sandboxViolationCount: violationCount,
        })
      })

      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })()
  })
}
