import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { getSetting } from '../services/settings.ts'
import { rewriteInstallCommand } from '../services/safe-install.ts'
import { installSocketFirewall, isSocketFirewallAvailable } from '../services/socket-firewall.ts'

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

      let output = ''
      let settled = false
      const stream = (data: Buffer) => {
        const text = data.toString()
        output += text
        win?.webContents.send('agent:shell_output', text)
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
        resolve({ output, exitCode: code ?? 0 })
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

const LOCKFILE_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const

function readLockfiles(cwd: string): Set<string> {
  return new Set(LOCKFILE_NAMES.filter((name) => existsSync(join(cwd, name))))
}

type PreparedCommand = { command: string; banner: string } | { refused: string }

/**
 * Harden package-install commands before they run: route them through Socket
 * Firewall (installing it first if needed) and apply safe install defaults.
 * Non-install commands pass through untouched.
 */
async function prepareCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<PreparedCommand> {
  if (!getSetting<boolean>('safeInstallEnabled', true)) return { command, banner: '' }

  const plan = rewriteInstallCommand(command, { lockfiles: readLockfiles(cwd) })
  if (!plan.isInstall) return { command, banner: '' }

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

  const banner = `[safe-install] ${plan.notes.join('; ')}\n$ ${plan.command}\n`
  getMainWindow()?.webContents.send('agent:shell_output', banner)
  return { command: plan.command, banner }
}

function formatShellSuccess(result: ShellRunResult): string {
  const clean = result.output.replace(/\[[0-9;]*m/g, '').trim()
  return clean || '(no output)'
}

function formatShellFailure(result: ShellRunResult): Error {
  const clean = result.output.replace(/\[[0-9;]*m/g, '').trim()
  return new Error(`Exited with code ${result.exitCode}:\n${clean}`)
}

export const runShellTool: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace directory. Output is streamed to the conversation. Commands contained within the sandbox auto-run; network or outside-workspace access prompts for approval. If a sandboxed command fails because the sandbox blocks it (e.g. Playwright), the user may approve running it once outside the sandbox. Package-manager installs (npm/pnpm/yarn/pip/uv/cargo/npx) are automatically scanned by Socket Firewall and hardened (--ignore-scripts, lockfile-pinned installs).',
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  }),
  async execute({ command, timeout_ms }, signal) {
    const cwd = getWorkspaceRoot()
    if (!cwd) return 'No workspace open.'

    const prepared = await prepareCommand(command, cwd, signal)
    if ('refused' in prepared) return prepared.refused
    const { command: finalCommand, banner } = prepared
    const withBanner = (output: string) => (banner ? `${banner}\n${output}` : output)

    let result: ShellRunResult
    try {
      result = await runShellOnce(finalCommand, cwd, timeout_ms, signal, false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retry = await maybeRetryUnsandboxed(
        finalCommand,
        cwd,
        timeout_ms,
        signal,
        message,
        null,
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
    )
    if (retry === 'declined') return 'User declined to run outside the sandbox.'
    if (retry) {
      if (retry.exitCode === 0) return withBanner(formatShellSuccess(retry))
      throw formatShellFailure(retry)
    }

    throw formatShellFailure(result)
  },
}
