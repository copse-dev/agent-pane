import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import quote from 'shell-quote'
import { workspaceSandboxOverlay } from './config.ts'

let enabled = false

export function isProjectSandboxEnabled(): boolean {
  return enabled && process.platform === 'darwin' && SandboxManager.isSandboxingEnabled()
}

export function setProjectSandboxEnabled(active: boolean): void {
  enabled = active
}

let cwdChain: Promise<void> = Promise.resolve()

/** ASRT resolves `./` paths and mandatory deny rules against `process.cwd()` at wrap time. */
function withWrapCwd<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const prev = process.cwd()
    try {
      process.chdir(workspaceRoot)
      return await fn()
    } finally {
      process.chdir(prev)
    }
  }
  const next = cwdChain.then(run, run)
  cwdChain = next.then(
    () => {},
    () => {},
  )
  return next
}

function shellCommand(executable: string, args: string[]): string {
  return quote.quote([executable, ...args])
}

export async function spawnInProjectSandbox(
  executable: string,
  args: string[],
  opts: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  if (!isProjectSandboxEnabled()) {
    return spawn(executable, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.stdio,
      signal: opts.signal,
    })
  }

  const command = shellCommand(executable, args)
  const customConfig = workspaceSandboxOverlay(opts.cwd)

  const { argv, env } = await withWrapCwd(opts.cwd, () =>
    SandboxManager.wrapWithSandboxArgv(command, '/bin/bash', customConfig, opts.signal),
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(file, argv.slice(1), {
    cwd: opts.cwd,
    env: { ...env, ...opts.env },
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
  } & Pick<SpawnOptionsWithoutStdio, 'stdio'>,
): Promise<ChildProcess> {
  if (!isProjectSandboxEnabled()) {
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
  const { argv, env } = await withWrapCwd(opts.cwd, () =>
    SandboxManager.wrapWithSandboxArgv(shellCommandLine, '/bin/bash', customConfig, opts.signal),
  )

  const file = argv[0]
  if (!file) throw new Error('sandbox wrap produced empty argv')
  return spawn(file, argv.slice(1), {
    cwd: opts.cwd,
    env: { ...env, ...opts.env },
    stdio: opts.stdio,
    signal: opts.signal,
  })
}

export function afterSandboxedCommand(): void {
  if (isProjectSandboxEnabled()) {
    SandboxManager.cleanupAfterCommand()
  }
}
