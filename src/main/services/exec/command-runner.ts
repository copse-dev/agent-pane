import { setPriority } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
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
import { leaseGitSshEnv } from '../ssh-workspace/git-ssh-env.ts'
import {
  internalGitEnv,
  withGitInvocationArgs,
  type GitConfigPolicy,
  type GitSigningBridge,
} from '../security/git-invocation.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  /**
   * Whether stdout exceeded `stdoutMaxBytes` and lost content.
   *
   * Overflow is dropped silently on the hot path (re-truncating a capped
   * buffer per chunk thrashed the GC), so the retained string looks like a
   * complete listing. Callers that reason about *scale* from output size must
   * consult this: the #795 file index read a 124,597-path checkout as 61,735
   * paths, sailed under the 100k semantic-index cap, and let gortex loose on
   * the whole tree.
   */
  stdoutTruncated: boolean
}

export interface RunCommandOptions {
  cwd?: string
  signal?: AbortSignal
  unsandboxed?: boolean
  /** Fail closed if the local sandbox authorized at the gate is no longer available. */
  requireSandbox?: boolean
  /** Extra env vars merged on top of the stripped base env (and any built-in tweaks like git's). */
  env?: NodeJS.ProcessEnv
  /** Bounded caller-owned input for a fixed subprocess (e.g. a signing broker). */
  stdin?: Buffer
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
  /**
   * Defaults to internal hardening. `user-command` preserves configured helpers
   * for an explicit add/commit only; the caller MUST pass the shell permission
   * gate first, including on hosts without a sandbox. Never derive from tool args.
   */
  gitConfig?: GitConfigPolicy
  gitSigning?: GitSigningBridge
}

/**
 * A run that hit its `timeout_ms` ceiling and was SIGKILLed, as distinct from a
 * command that failed on its own terms.
 *
 * Some callers deliberately budget less time than the work can take — the
 * gortex indexer keeps going in its daemon after we stop waiting — so they need
 * to tell "we stopped waiting" apart from "it broke" instead of matching on the
 * message text.
 */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(cmd: string, timeoutMs: number) {
    super(`Command timed out after ${String(timeoutMs)}ms: ${cmd}`)
    this.name = 'CommandTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export const isCommandTimeoutError: (err: unknown) => err is CommandTimeoutError = (err) =>
  err instanceof CommandTimeoutError

function prepareGitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  policy: GitConfigPolicy,
  signing?: GitSigningBridge,
): { args: string[]; env: NodeJS.ProcessEnv; releaseGitSsh?: () => void } {
  const preparedArgs = withGitInvocationArgs(args, policy, signing)
  const transport = policy === 'internal' && ['fetch', 'push'].includes(args[0] ?? '')
  // Remove ambient Git/SSH executable injection before installing Copse's own
  // askpass and host-key policy. Scrubbing after the lease would also delete
  // those trusted bridge variables and break authenticated fetch/push.
  const preparedEnv = policy === 'internal' ? internalGitEnv(env, transport) : env
  const gitSsh = leaseGitSshEnv(preparedEnv)
  return {
    args: preparedArgs,
    env: gitSsh.env,
    releaseGitSsh: gitSsh.release,
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
  let releaseGitSsh: (() => void) | undefined
  if (opts.env) {
    spawnEnv = { ...spawnEnv, ...opts.env }
  }
  if (cmd === 'git') {
    const git = prepareGitInvocation(args, spawnEnv, opts.gitConfig ?? 'internal', opts.gitSigning)
    spawnArgs = git.args
    spawnEnv = git.env
    releaseGitSsh = git.releaseGitSsh
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
        if (opts.requireSandbox !== undefined) spawnOpts.requireSandbox = opts.requireSandbox
        if (opts.sandboxConfig) spawnOpts.sandboxConfig = opts.sandboxConfig
        if (opts.signal) spawnOpts.signal = opts.signal
        proc = await spawnInProjectSandbox(cmd, spawnArgs, spawnOpts)
        if (opts.stdin) {
          // A signer can reject input and close its pipe before it is drained.
          proc.stdin?.on('error', () => {})
          proc.stdin?.end(opts.stdin)
        }
        if (opts.lowPriority && typeof proc.pid === 'number') {
          // nice 19: keep a CPU-heavy background job from starving the UI (#517).
          try {
            setPriority(proc.pid, 19)
          } catch {
            // Non-fatal: priority is an optimisation, and setPriority can EPERM.
          }
        }
      } catch (err) {
        releaseGitSsh?.()
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      let stdout = ''
      let stderr = ''
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
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
                reject(new CommandTimeoutError(cmd, timeout_ms))
              }
            }, timeout_ms)
          : undefined

      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer)
        cancelKill?.()
        opts.signal?.removeEventListener('abort', onAbort)
        releaseGitSsh?.()
        if (!opts.unsandboxed) afterSandboxedCommand()
        fn()
      }

      // Once accumulated output reaches its cap, DROP further chunks instead of
      // re-appending: `appendFlatCapped` re-scans and re-truncates the whole
      // capped buffer on every chunk, so a subprocess that keeps emitting past
      // the cap spins O(chunks × cap) and churns multi-MB allocations (observed
      // as ~250 MB/cycle GC thrash that starved the event loop). Track raw bytes
      // (O(1) per chunk) and stop once over the cap; the process keeps draining
      // its pipe and exits normally, we just ignore the overflow we'd discard
      // anyway.
      let rawStdoutBytes = 0
      let stdoutCapped = false
      let rawStderrBytes = 0
      let stderrCapped = false
      proc.stdout?.on('data', (d: Buffer) => {
        rawStdoutBytes += d.length
        if (stdoutCapped) return
        stdout = appendFlatCapped(stdout, stdoutDecoder.write(d), stdoutMaxBytes)
        if (rawStdoutBytes >= stdoutMaxBytes) stdoutCapped = true
      })
      proc.stderr?.on('data', (d: Buffer) => {
        rawStderrBytes += d.length
        if (stderrCapped) return
        stderr = appendFlatCapped(stderr, stderrDecoder.write(d), COMMAND_OUTPUT_MAX_BYTES)
        if (rawStderrBytes >= COMMAND_OUTPUT_MAX_BYTES) stderrCapped = true
      })

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        finish(() => {
          if (!stdoutCapped) stdout = appendFlatCapped(stdout, stdoutDecoder.end(), stdoutMaxBytes)
          if (!stderrCapped)
            stderr = appendFlatCapped(stderr, stderrDecoder.end(), COMMAND_OUTPUT_MAX_BYTES)
          resolve({
            stdout,
            stderr,
            code: code ?? 1,
            stdoutTruncated: rawStdoutBytes > stdoutMaxBytes,
          })
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
