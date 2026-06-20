import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { getMainWindow } from '../windows/create-main-window.ts'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  spawnShellInProjectSandbox,
} from '../project-sandbox/index.ts'
import { detectLikelySandboxFailure } from '../services/sandbox-failure.ts'
import { promptUnsandboxedShell } from '../services/permission-gate.ts'
import {
  CappedOutputAccumulator,
  stripTerminalControlSequences,
} from '../services/subprocess-output-cap.ts'

interface ShellRunResult {
  output: string
  exitCode: number
}

async function runShellOnce(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  unsandboxed: boolean,
): Promise<ShellRunResult> {
  const win = getMainWindow()

  return new Promise<ShellRunResult>((resolve, reject) => {
    void (async () => {
      let proc
      try {
        proc = await spawnShellInProjectSandbox(command, {
          cwd,
          env: process.env,
          stdio: 'pipe',
          signal,
          unsandboxed,
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      const outputAcc = new CappedOutputAccumulator()
      let settled = false
      const stream = (data: Buffer) => {
        const toStream = outputAcc.append(data.toString())
        if (toStream) win?.webContents.send('agent:shell_output', toStream)
      }
      proc.stdout?.on('data', stream)
      proc.stderr?.on('data', stream)

      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        if (!settled) {
          settled = true
          reject(new Error(`Command timed out after ${timeout_ms}ms`))
        }
      }, timeout_ms)

      const finish = () => {
        if (!unsandboxed) afterSandboxedCommand()
      }

      proc.on('error', (err) => {
        clearTimeout(timer)
        finish()
        if (!settled) {
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        finish()
        if (settled) return
        settled = true
        resolve({ output: outputAcc.toString(), exitCode: code ?? 0 })
      })

      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        proc.kill('SIGKILL')
      })
    })()
  })
}

async function maybeRetryUnsandboxed(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  output: string,
  exitCode: number | null,
): Promise<ShellRunResult | 'declined' | null> {
  if (!isProjectSandboxEnabled()) return null
  const detection = detectLikelySandboxFailure(output, exitCode)
  if (!detection.likely) return null
  const approved = await promptUnsandboxedShell(command, detection.reasons)
  if (!approved) return 'declined'
  return runShellOnce(command, cwd, timeout_ms, signal, true)
}

function formatShellSuccess(result: ShellRunResult): string {
  const clean = stripTerminalControlSequences(result.output).trim()
  return clean || '(no output)'
}

function formatShellFailure(result: ShellRunResult): Error {
  const clean = stripTerminalControlSequences(result.output).trim()
  return new Error(`Exited with code ${result.exitCode}:\n${clean}`)
}

export const runShellTool: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace directory. Output is streamed to the conversation. Commands contained within the sandbox auto-run; network or outside-workspace access prompts for approval. If a sandboxed command fails because the sandbox blocks it (e.g. Playwright), the user may approve running it once outside the sandbox.',
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  }),
  async execute({ command, timeout_ms }, signal) {
    const cwd = getWorkspaceRoot()
    if (!cwd) return 'No workspace open.'

    let result: ShellRunResult
    try {
      result = await runShellOnce(command, cwd, timeout_ms, signal, false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retry = await maybeRetryUnsandboxed(command, cwd, timeout_ms, signal, message, null)
      if (retry === 'declined') return 'User declined to run outside the sandbox.'
      if (retry) {
        if (retry.exitCode === 0) return formatShellSuccess(retry)
        throw formatShellFailure(retry)
      }
      throw err
    }

    if (result.exitCode === 0) return formatShellSuccess(result)

    const retry = await maybeRetryUnsandboxed(
      command,
      cwd,
      timeout_ms,
      signal,
      result.output,
      result.exitCode,
    )
    if (retry === 'declined') return 'User declined to run outside the sandbox.'
    if (retry) {
      if (retry.exitCode === 0) return formatShellSuccess(retry)
      throw formatShellFailure(retry)
    }

    throw formatShellFailure(result)
  },
}
