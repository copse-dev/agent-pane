import { errorMessage } from '@shared/errors.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
  spawnShellInProjectSandbox,
} from '../../project-sandbox/index.ts'
import { CappedOutputAccumulator } from './subprocess-output-cap.ts'
import { terminateProcessTree } from './subprocess-kill.ts'
import { emitShellOutput } from './shell-output-context.ts'
import { adoptSupervisedBackgroundProcess } from './supervised-background-process.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'

export interface ShellRunResult {
  output: string
  exitCode: number
  sandboxViolationCount?: number
  backgroundId?: string
  /** The sandbox wrapper process itself failed to start (child 'error' event). */
  spawnFailed?: boolean
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
      let proc
      try {
        proc = await spawnShellInProjectSandbox(command, {
          cwd,
          env,
          stdio: 'pipe',
          unsandboxed,
          readGrantTargets,
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

      const startedAt = Date.now()
      const ranUnsandboxed = unsandboxed || !isProjectSandboxEnabled()
      const outputAcc = new CappedOutputAccumulator()
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
        clearTimeout(timer)
        cancelKill?.()
        signal.removeEventListener('abort', onAbort)
      }

      const timer = setTimeout(() => {
        cancelKill = terminateProcessTree(proc)
        if (!settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(new Error(`Command timed out after ${String(timeout_ms)}ms`))
        }
      }, timeout_ms)

      const sandboxViolationCount = (): number =>
        unsandboxed ? 0 : sandboxViolationCountForCommand(command)

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

      proc.on('close', (code) => {
        cleanup()
        const violationCount = sandboxViolationCount()
        finish()
        if (settled) return
        settled = true
        resolve({
          output: outputAcc.toString(),
          exitCode: code ?? 0,
          sandboxViolationCount: violationCount,
        })
      })

      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })()
  })
}
