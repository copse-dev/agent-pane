import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import quote from 'shell-quote'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { posixQuote } from '../services/safe-install.ts'
import { workspaceSandboxOverlay } from './config.ts'

let enabled = false

export function isProjectSandboxEnabled(): boolean {
  return enabled && process.platform === 'darwin' && SandboxManager.isSandboxingEnabled()
}

export function setProjectSandboxEnabled(active: boolean): void {
  enabled = active
}

/** Join argv for `/bin/sh -c` / ASRT wrap. Uses POSIX single quotes so paths with spaces stay one word. */
export function formatArgvForShell(executable: string, args: string[]): string {
  return [executable, ...args].map(posixQuote).join(' ')
}

function shellCommand(executable: string, args: string[]): string {
  return formatArgvForShell(executable, args)
}

function mergeSpawnEnv(base: NodeJS.ProcessEnv, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!override) return base
  return { ...base, ...override }
}

/** POSIX-only: run the child as its own process-group leader so the group can be killed together. */
const detachForGroupKill = process.platform !== 'win32'
const DEFAULT_SANDBOX_SHELL = '/bin/bash'

function ensurePathIncludes(dirs: string[]): void {
  if (process.platform === 'win32') return
  const current = process.env.PATH ?? ''
  const seen = new Set(current.split(':').filter(Boolean))
  const missing = dirs.filter((dir) => !seen.has(dir))
  if (missing.length > 0) {
    process.env.PATH = [...missing, current].filter(Boolean).join(':')
  }
}

export function shellForSandboxWrap(shellPath: string = DEFAULT_SANDBOX_SHELL): string {
  if (process.platform === 'win32' || !shellPath.includes('/')) return shellPath
  ensurePathIncludes([dirname(shellPath), '/usr/bin', '/bin'])
  return basename(shellPath)
}

export async function spawnInProjectSandbox(
  executable: string,
  args: string[],
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
    sandboxConfig?: Partial<SandboxRuntimeConfig>
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    return spawn(executable, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.stdio,
      signal: opts.signal,
      detached: detachForGroupKill,
    })
  }

  const command = shellCommand(executable, args)
  const customConfig = opts.sandboxConfig ?? workspaceSandboxOverlay(opts.cwd)

  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    shellForSandboxWrap(),
    customConfig,
    opts.signal,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(file, argv.slice(1), {
    cwd: opts.cwd,
    env: mergeSpawnEnv(env, opts.env),
    stdio: opts.stdio,
    signal: opts.signal,
    detached: detachForGroupKill,
  })
}

export async function spawnShellInProjectSandbox(
  shellCommandLine: string,
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs =
      process.platform === 'win32' ? ['/c', shellCommandLine] : ['-c', shellCommandLine]
    return spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.stdio,
      signal: opts.signal,
      detached: detachForGroupKill,
    })
  }

  const customConfig = workspaceSandboxOverlay(opts.cwd)
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    shellCommandLine,
    shellForSandboxWrap(),
    customConfig,
    opts.signal,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(file, argv.slice(1), {
    cwd: opts.cwd,
    env: mergeSpawnEnv(env, opts.env),
    stdio: opts.stdio,
    signal: opts.signal,
    detached: detachForGroupKill,
  })
}

/**
 * Number of sandbox policy violations the runner (ASRT) recorded for a command.
 * This is a runner/kernel-side signal — it is NOT derived from the command's own
 * stdout/stderr, so a command cannot forge it by echoing "operation not permitted"
 * to trick the user into an unsandboxed re-run (issue #104).
 *
 * Returns 0 when the sandbox is inactive or no violation log is available.
 */
export function sandboxViolationCountForCommand(command: string): number {
  if (!isProjectSandboxEnabled()) return 0
  try {
    const store = SandboxManager.getSandboxViolationStore()
    return store.getViolationsForCommand(command).length
  } catch {
    return 0
  }
}

export function afterSandboxedCommand(): void {
  if (isProjectSandboxEnabled()) {
    SandboxManager.cleanupAfterCommand()
  }
}

export interface SpawnPtyOptions {
  cwd: string
  cols: number
  rows: number
  env?: NodeJS.ProcessEnv
  /** Integrated terminals are user-controlled; default is outside the project sandbox. */
  unsandboxed?: boolean
}

/** Spawn an interactive shell PTY; optionally routed through ASRT when the project sandbox is active. */
export async function spawnPtyInProjectSandbox(
  shell: string,
  opts: SpawnPtyOptions,
): Promise<IPty> {
  const termEnv = {
    ...process.env,
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  } as Record<string, string>

  const ptyOpts = {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: termEnv,
  }

  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    return pty.spawn(shell, [], ptyOpts)
  }

  const customConfig = { ...workspaceSandboxOverlay(opts.cwd), allowPty: true }
  const innerCommand = `exec ${quote.quote([shell])} -il`
  // cwd is handed to pty.spawn via ptyOpts; no main-process chdir during wrap (#74).
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    innerCommand,
    shellForSandboxWrap(shell),
    customConfig,
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return pty.spawn(file, argv.slice(1), {
    ...ptyOpts,
    env: { ...env, ...termEnv },
  })
}
