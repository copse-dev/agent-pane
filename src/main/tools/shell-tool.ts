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
import { promptInstallSocketFirewall, promptUnsandboxedShell } from '../services/permission-gate.ts'
import { shellRequiresOutsideSandbox } from '../services/permission-policy.ts'
import { getSetting } from '../services/settings.ts'
import { detectPackageInstall, wrapWithSocketFirewall } from '../services/safe-install.ts'
import { installSocketFirewall, isSocketFirewallAvailable } from '../services/socket-firewall.ts'
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
  env: NodeJS.ProcessEnv,
): Promise<ShellRunResult> {
  const win = getMainWindow()

  return new Promise<ShellRunResult>((resolve, reject) => {
    void (async () => {
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
  env: NodeJS.ProcessEnv,
): Promise<ShellRunResult | 'declined' | null> {
  if (!isProjectSandboxEnabled()) return null
  const detection = detectLikelySandboxFailure(output, exitCode)
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
  getMainWindow()?.webContents.send('agent:shell_output', banner)
  return { command: wrapped, env, banner }
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
    'Run a shell command in the workspace directory. Output is streamed to the conversation. Commands contained within the sandbox auto-run; network or outside-workspace access (e.g. gh, curl, git push) prompts for approval and runs outside the sandbox when the macOS project sandbox is active. If a sandbox-contained command fails because the sandbox blocks it (e.g. Playwright), the user may approve running it once outside the sandbox. Package-manager installs (npm/pnpm/yarn/pip/uv/cargo/npx) are automatically run through Socket Firewall to scan for malicious packages, with install lifecycle scripts disabled.',
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
    const withBanner = (output: string) => (banner ? `${banner}\n${output}` : output)

    const outsideSandbox = shellRequiresOutsideSandbox(finalCommand, cwd, isProjectSandboxEnabled())

    let result: ShellRunResult
    try {
      result = await runShellOnce(finalCommand, cwd, timeout_ms, signal, outsideSandbox, env)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retry = await maybeRetryUnsandboxed(
        finalCommand,
        cwd,
        timeout_ms,
        signal,
        message,
        null,
        env,
      )
      if (retry === 'declined') return 'User declined to run outside the sandbox.'
      if (retry) {
        if (retry.exitCode === 0) return withBanner(formatShellSuccess(retry))
        throw formatShellFailure(retry)
      }
      throw err
    }

    if (result.exitCode === 0) return withBanner(formatShellSuccess(result))

    const retry = await maybeRetryUnsandboxed(
      finalCommand,
      cwd,
      timeout_ms,
      signal,
      result.output,
      result.exitCode,
      env,
    )
    if (retry === 'declined') return 'User declined to run outside the sandbox.'
    if (retry) {
      if (retry.exitCode === 0) return withBanner(formatShellSuccess(retry))
      throw formatShellFailure(retry)
    }

    throw formatShellFailure(result)
  },
}
