import { getWorkspaceRoot } from './workspace.ts'
import { afterSandboxedCommand, spawnInProjectSandbox } from '../project-sandbox/index.ts'
import {
  appendFlatCapped,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_RUNNER_DEFAULT_TIMEOUT_MS,
} from './subprocess-output-cap.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface RunCommandOptions {
  cwd?: string
  signal?: AbortSignal
  unsandboxed?: boolean
  /** Extra env vars merged on top of `process.env` (and any built-in tweaks like git's). */
  env?: NodeJS.ProcessEnv
  /** Defaults to {@link COMMAND_RUNNER_DEFAULT_TIMEOUT_MS}; pass `0` to disable. */
  timeout_ms?: number
}

function prepareGitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ['-c', 'core.pager=cat', '--no-color', ...args],
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
  }
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  const cwd = opts.cwd ?? getWorkspaceRoot() ?? process.cwd()
  const timeout_ms = opts.timeout_ms ?? COMMAND_RUNNER_DEFAULT_TIMEOUT_MS

  let spawnArgs = args
  let spawnEnv: NodeJS.ProcessEnv = { ...process.env }
  if (cmd === 'git') {
    const git = prepareGitInvocation(args, spawnEnv)
    spawnArgs = git.args
    spawnEnv = git.env
  }
  if (opts.env) {
    spawnEnv = { ...spawnEnv, ...opts.env }
  }

  return new Promise((resolve, reject) => {
    void (async () => {
      let proc
      try {
        const spawnOpts: Parameters<typeof spawnInProjectSandbox>[2] = {
          cwd,
          env: spawnEnv,
          stdio: 'pipe',
        }
        if (opts.unsandboxed !== undefined) spawnOpts.unsandboxed = opts.unsandboxed
        if (opts.signal) spawnOpts.signal = opts.signal
        proc = await spawnInProjectSandbox(cmd, spawnArgs, spawnOpts)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer =
        timeout_ms > 0
          ? setTimeout(() => {
              proc.kill('SIGKILL')
              if (!settled) {
                settled = true
                reject(new Error(`Command timed out after ${timeout_ms}ms: ${cmd}`))
              }
            }, timeout_ms)
          : undefined

      const finish = (fn: () => void) => {
        if (timer) clearTimeout(timer)
        if (!opts.unsandboxed) afterSandboxedCommand()
        fn()
      }

      proc.stdout?.on('data', (d: Buffer) => {
        stdout = appendFlatCapped(stdout, d.toString(), COMMAND_OUTPUT_MAX_BYTES)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        stderr = appendFlatCapped(stderr, d.toString(), COMMAND_OUTPUT_MAX_BYTES)
      })

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        finish(() => resolve({ stdout, stderr, code: code ?? 0 }))
      })

      proc.on('error', (err) => {
        if (settled) return
        settled = true
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      })

      opts.signal?.addEventListener('abort', () => {
        proc.kill('SIGKILL')
      })
    })()
  })
}
