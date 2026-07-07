import { setPriority } from 'node:os'
import { getWorkspaceRoot } from '../workspace.ts'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { afterSandboxedCommand, spawnInProjectSandbox } from '../../project-sandbox/index.ts'
import { envForRendererChildProcess } from './child-process-env.ts'
import {
  appendFlatCapped,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_RUNNER_DEFAULT_TIMEOUT_MS,
} from './subprocess-output-cap.ts'
import { terminateProcessTree } from './subprocess-kill.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface RunCommandOptions {
  cwd?: string
  signal?: AbortSignal
  unsandboxed?: boolean
  /** Extra env vars merged on top of the stripped base env (and any built-in tweaks like git's). */
  env?: NodeJS.ProcessEnv
  /** Defaults to {@link COMMAND_RUNNER_DEFAULT_TIMEOUT_MS}; pass `0` to disable. */
  timeout_ms?: number
  /**
   * Run the child at the lowest CPU scheduling priority (nice 19) so a heavy
   * background job (e.g. the gortex indexer, #517) yields to the foreground
   * UI instead of causing typing lag. Best-effort: it lowers the spawned
   * process — descendants forked before we set it keep the default priority —
   * and a failed `setPriority` (EPERM) is ignored.
   */
  lowPriority?: boolean
  /** Defaults to {@link COMMAND_OUTPUT_MAX_BYTES}. */
  stdoutMaxBytes?: number
  /** Overrides workspace seatbelt rules for this spawn (e.g. sandbox-fs worker). */
  sandboxConfig?: Partial<SandboxRuntimeConfig>
}

function prepareGitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    // --no-pager: never invoke a pager (which would hang waiting on a terminal).
    // core.pager=cat: belt-and-suspenders for subcommands that bypass --no-pager.
    // color.ui=false: disable color globally (`git --no-color` is not a valid global flag).
    args: ['--no-pager', '-c', 'core.pager=cat', '-c', 'color.ui=false', ...args],
    env: {
      ...env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      // Never block on credential / SSH host-key prompts.
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: env['GIT_SSH_COMMAND'] ?? 'ssh -oBatchMode=yes',
    },
  }
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  const cwd = opts.cwd ?? getWorkspaceRoot() ?? process.cwd()
  const timeout_ms = opts.timeout_ms ?? COMMAND_RUNNER_DEFAULT_TIMEOUT_MS
  const stdoutMaxBytes = opts.stdoutMaxBytes ?? COMMAND_OUTPUT_MAX_BYTES

  let spawnArgs = args
  // Base env always excludes LLM/provider secrets (#579): every caller is a
  // git/gh/ripgrep-style tool that never needs them, and the strip list keeps
  // tool tokens (GITHUB_TOKEN, NPM_TOKEN, AWS_*). Callers that genuinely need
  // a secret can pass it explicitly via `opts.env`.
  let spawnEnv: NodeJS.ProcessEnv = envForRendererChildProcess()
  if (cmd === 'git') {
    const git = prepareGitInvocation(args, spawnEnv)
    spawnArgs = git.args
    spawnEnv = git.env
  }
  if (opts.env) {
    spawnEnv = { ...spawnEnv, ...opts.env }
  }

  return new Promise((resolve, reject) => {
    void (async (): Promise<void> => {
      let proc
      try {
        const spawnOpts: Parameters<typeof spawnInProjectSandbox>[2] = {
          cwd,
          env: spawnEnv,
          stdio: 'pipe',
        }
        if (opts.unsandboxed !== undefined) spawnOpts.unsandboxed = opts.unsandboxed
        if (opts.sandboxConfig) spawnOpts.sandboxConfig = opts.sandboxConfig
        if (opts.signal) spawnOpts.signal = opts.signal
        proc = await spawnInProjectSandbox(cmd, spawnArgs, spawnOpts)
        if (opts.lowPriority && typeof proc.pid === 'number') {
          // nice 19: keep a CPU-heavy background job from starving the UI (#517).
          try {
            setPriority(proc.pid, 19)
          } catch {
            // Non-fatal: priority is an optimisation, and setPriority can EPERM.
          }
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let cancelKill: (() => void) | undefined

      const onAbort = (): void => {
        if (timer) clearTimeout(timer)
        cancelKill = terminateProcessTree(proc)
      }

      const timer =
        timeout_ms > 0
          ? setTimeout(() => {
              cancelKill = terminateProcessTree(proc)
              if (!settled) {
                settled = true
                opts.signal?.removeEventListener('abort', onAbort)
                reject(new Error(`Command timed out after ${String(timeout_ms)}ms: ${cmd}`))
              }
            }, timeout_ms)
          : undefined

      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer)
        cancelKill?.()
        opts.signal?.removeEventListener('abort', onAbort)
        if (!opts.unsandboxed) afterSandboxedCommand()
        fn()
      }

      proc.stdout?.on('data', (d: Buffer) => {
        stdout = appendFlatCapped(stdout, d.toString(), stdoutMaxBytes)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        stderr = appendFlatCapped(stderr, d.toString(), COMMAND_OUTPUT_MAX_BYTES)
      })

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        finish(() => {
          resolve({ stdout, stderr, code: code ?? 0 })
        })
      })

      proc.on('error', (err) => {
        if (settled) return
        settled = true
        finish(() => {
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })

      opts.signal?.addEventListener('abort', onAbort)
    })()
  })
}
