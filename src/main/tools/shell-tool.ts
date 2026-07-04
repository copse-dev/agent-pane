import { errorMessage } from '@shared/errors.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { getMainWindow } from '../windows/create-main-window.ts'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
  spawnShellInProjectSandbox,
} from '../project-sandbox/index.ts'
import { detectSandboxFailure } from '../services/security/sandbox-failure.ts'
import { promptInstallSocketFirewall, promptUnsandboxedShell } from '../services/security/permission-gate.ts'
import {
  shellRequiresOutsideSandbox,
  shellSandboxFailureShouldOfferUnsandboxedRetry,
} from '../services/security/permission-policy.ts'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import { getSetting } from '../services/settings.ts'
import { detectPackageInstall, wrapWithSocketFirewall } from '../services/security/safe-install.ts'
import { installSocketFirewall, isSocketFirewallAvailable } from '../services/security/socket-firewall.ts'
import {
  CappedOutputAccumulator,
  stripTerminalControlSequences,
} from '../services/exec/subprocess-output-cap.ts'
import { terminateProcessTree } from '../services/exec/subprocess-kill.ts'
import { adoptWorktreeChangesSince, captureWorktreeBaseline } from '../services/diff-queue.ts'
import { getCurrentShellTaskId } from '../services/exec/shell-output-context.ts'

interface ShellRunResult {
  output: string
  exitCode: number
  sandboxViolationCount?: number
  /** The sandbox wrapper process itself failed to start (child 'error' event). */
  spawnFailed?: boolean
}

async function runShellOnce(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  unsandboxed: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ShellRunResult> {
  const win = getMainWindow()

  return new Promise<ShellRunResult>((resolve, reject) => {
    void (async (): Promise<void> => {
      let proc
      try {
        proc = await spawnShellInProjectSandbox(command, {
          cwd,
          env,
          stdio: 'pipe',
          signal,
          unsandboxed,
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
      }

      const outputAcc = new CappedOutputAccumulator()
      let settled = false
      let cancelKill: (() => void) | undefined
      const stream = (data: Buffer): void => {
        const toStream = outputAcc.append(data.toString())
        if (toStream) win?.webContents.send('agent:shell_output', toStream, getCurrentShellTaskId())
      }
      proc.stdout?.on('data', stream)
      proc.stderr?.on('data', stream)

      const onAbort = (): void => {
        clearTimeout(timer)
        cancelKill = terminateProcessTree(proc)
      }

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

      signal.addEventListener('abort', onAbort)
    })()
  })
}

async function maybeRetryUnsandboxed(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  result: ShellRunResult,
  env: NodeJS.ProcessEnv,
): Promise<ShellRunResult | 'declined' | null> {
  if (!isProjectSandboxEnabled()) return null
  if (!shellSandboxFailureShouldOfferUnsandboxedRetry(command, cwd)) {
    return null
  }
  // Decide purely from runner-side signals (recorded sandbox violations / wrapper
  // spawn failure) — never from the command's own stdout/stderr (issue #104).
  const detection = detectSandboxFailure({
    exitCode: result.exitCode,
    violationCount: result.sandboxViolationCount ?? sandboxViolationCountForCommand(command),
    spawnFailed: result.spawnFailed ?? false,
  })
  if (!detection.likely) return null
  const approved = await promptUnsandboxedShell(command, detection.reasons)
  if (!approved) return 'declined'
  return runShellOnce(command, cwd, timeout_ms, signal, true, env)
}

const SHELL_INVOCATION =
  process.platform === 'win32' ? { path: 'cmd', cArg: '/c' } : { path: '/bin/sh', cArg: '-c' }

const winQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`

type PreparedCommand =
  | { command: string; env: NodeJS.ProcessEnv; banner: string }
  | { refused: string }

/**
 * When a command performs a package install, route the whole command through
 * Socket Firewall once (installing sfw first if needed) so the package manager
 * it invokes is proxied. JS managers additionally get `npm_config_ignore_scripts`
 * to block install lifecycle scripts. Non-install commands pass through untouched.
 */
async function prepareCommand(command: string, signal: AbortSignal): Promise<PreparedCommand> {
  const baseEnv = process.env
  if (!getSetting<boolean>('safeInstallEnabled', true)) {
    return { command, env: baseEnv, banner: '' }
  }

  const detection = detectPackageInstall(command)
  if (!detection.isInstall) return { command, env: baseEnv, banner: '' }

  if (!isSocketFirewallAvailable()) {
    const approved = await promptInstallSocketFirewall(command)
    if (!approved) {
      return {
        refused:
          'Package install cancelled: Socket Firewall (sfw) is required to scan packages and was not installed.',
      }
    }
    const installed = await installSocketFirewall(signal)
    if (!installed) {
      return { refused: 'Package install cancelled: Socket Firewall (sfw) installation failed.' }
    }
  }

  const quote = process.platform === 'win32' ? winQuote : undefined
  const wrapped = wrapWithSocketFirewall(command, SHELL_INVOCATION, quote)
  const env: NodeJS.ProcessEnv = detection.jsManager
    ? { ...baseEnv, npm_config_ignore_scripts: 'true' }
    : baseEnv
  const notes = [
    'scanned by Socket Firewall (sfw)',
    ...(detection.jsManager ? ['install scripts disabled (npm_config_ignore_scripts)'] : []),
  ]
  const banner = `[safe-install] ${notes.join('; ')}\n$ ${wrapped}\n`
  getMainWindow()?.webContents.send('agent:shell_output', banner, getCurrentShellTaskId())
  return { command: wrapped, env, banner }
}

function formatShellSuccess(result: ShellRunResult): string {
  const clean = stripTerminalControlSequences(result.output).trim()
  return clean || '(no output)'
}

function formatShellFailure(result: ShellRunResult): Error {
  const clean = stripTerminalControlSequences(result.output).trim()
  return new Error(`Exited with code ${String(result.exitCode)}:\n${clean}`)
}

export const runShellTool = defineTool({
  name: 'run_shell',
  description:
    'Run a shell command for tests, builds, installs, and other tasks not covered by a dedicated tool — not for reading files or searching code (use read_file/search tools or explore). Output is streamed to the conversation. Commands contained within the sandbox auto-run; network or outside-workspace access (e.g. gh, curl, git push) prompts for approval and runs outside the sandbox when the macOS project sandbox is active. If a sandbox-contained command fails because the sandbox blocks filesystem/process access (e.g. Playwright), the user may approve running it once outside the sandbox. Package-manager installs (npm/pnpm/yarn/pip/uv/cargo/npx) are automatically run through Socket Firewall to scan for malicious packages, with install lifecycle scripts disabled.',
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  }),
  async execute({ command, timeout_ms }, signal) {
    const cwd = getWorkspaceRoot()
    if (!cwd) return 'No workspace open.'

    const prepared = await prepareCommand(command, signal)
    if ('refused' in prepared) return prepared.refused
    const { command: finalCommand, env, banner } = prepared
    const withBanner = (output: string): string => (banner ? `${banner}\n${output}` : output)

    const outsideSandbox = shellRequiresOutsideSandbox(finalCommand, cwd, isProjectSandboxEnabled())

    // Strip LLM API keys (and other secrets) from the child env so a compromised
    // command — especially an unsandboxed retry with full network — cannot exfiltrate
    // them (issue #108). prepareCommand's own additions (e.g. npm_config_ignore_scripts)
    // are preserved on top.
    const childEnv = envForRendererChildProcess(env)

    // Bracket the run so any file this agent-triggered command changes (e.g. a
    // formatter rewriting a file Copse just edited) is adopted as Copse-owned —
    // keeping the worktree "clean" for direct edits on the next turn. Runs in a
    // finally because a command can change files even when it exits non-zero or
    // the runner throws. Scoped to the command's real effects by the baseline diff.
    const baseline = await captureWorktreeBaseline()
    try {
      const result = await runShellOnce(
        finalCommand,
        cwd,
        timeout_ms,
        signal,
        outsideSandbox,
        childEnv,
      )

      if (result.exitCode === 0) return withBanner(formatShellSuccess(result))

      const retry = await maybeRetryUnsandboxed(
        finalCommand,
        cwd,
        timeout_ms,
        signal,
        result,
        childEnv,
      )
      if (retry === 'declined') return 'User declined to run outside the sandbox.'
      if (retry) {
        if (retry.exitCode === 0) return withBanner(formatShellSuccess(retry))
        throw formatShellFailure(retry)
      }

      throw formatShellFailure(result)
    } finally {
      await adoptWorktreeChangesSince(baseline)
    }
  },
})
