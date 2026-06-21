import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import quote from 'shell-quote'
import { workspaceSandboxOverlay } from './config.ts'

let enabled = false

export function isProjectSandboxEnabled(): boolean {
  return enabled && process.platform === 'darwin' && SandboxManager.isSandboxingEnabled()
}

export function setProjectSandboxEnabled(active: boolean): void {
  enabled = active
}

function shellCommand(executable: string, args: string[]): string {
  return quote.quote([executable, ...args])
}

function mergeSpawnEnv(base: NodeJS.ProcessEnv, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!override) return base
  return { ...base, ...override }
}

export async function spawnInProjectSandbox(
  executable: string,
  args: string[],
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    unsandboxed?: boolean
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  if (!isProjectSandboxEnabled() || opts.unsandboxed) {
    return spawn(executable, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.stdio,
      signal: opts.signal,
    })
  }

  const command = shellCommand(executable, args)
  const customConfig = workspaceSandboxOverlay(opts.cwd)

  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    '/bin/bash',
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
    })
  }

  const customConfig = workspaceSandboxOverlay(opts.cwd)
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    shellCommandLine,
    '/bin/bash',
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
  })
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
}

/** Spawn an interactive shell PTY, routed through ASRT when the project sandbox is active. */
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

  if (!isProjectSandboxEnabled()) {
    return pty.spawn(shell, [], ptyOpts)
  }

  const customConfig = { ...workspaceSandboxOverlay(opts.cwd), allowPty: true }
  const innerCommand = `exec ${quote.quote([shell])} -il`
  // cwd is handed to pty.spawn via ptyOpts; no main-process chdir during wrap (#74).
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(innerCommand, shell, customConfig)

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return pty.spawn(file, argv.slice(1), {
    ...ptyOpts,
    env: { ...env, ...termEnv },
  })
}
