/**
 * The one runner for automatic Git that the app runs directly on a host
 * checkout, outside `runCommand` and the project sandbox: container-run
 * carry-in/carry-out and adoption, and the hosted (OpenAI) source transfer.
 * These operations are app plumbing the user did not type, so they take the
 * internal policy from `git-invocation.ts`: the command allowlist, the
 * execution-time `-c` overrides (fsmonitor, hooks, signing, pager, maintenance)
 * and the scrubbed environment. A checkout's own configuration must not choose
 * a program for them to run (GitSpawn).
 *
 * Without OS containment this keeps the overrides only, which is the same
 * stance the threat model takes for Windows and sandbox-initialization
 * failures. Content filters and merge drivers keep Git's normal semantics (see
 * `docs/threat-model.md`, "Internal Git execution").
 *
 * Rejections are `execFile`'s own, so a caller can still read the exit `code`
 * (e.g. `git grep` exits 1 for "no match").
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { internalGitEnv, internalGitTransport, withGitInvocationArgs } from './git-invocation.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

export interface InternalGitOptions {
  /** Extra environment, e.g. `GIT_INDEX_FILE` for a throwaway snapshot index. */
  env?: Record<string, string>
  maxBuffer?: number
}

function prepare(
  cwd: string,
  args: string[],
  options: InternalGitOptions,
): { args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number } } {
  return {
    args: withGitInvocationArgs(args),
    options: {
      cwd,
      // Provider secrets never reach Git or anything it could start; the
      // caller's extra environment is scrubbed together with the base.
      env: internalGitEnv(
        { ...envForRendererChildProcess(), ...options.env },
        internalGitTransport(args[0]),
      ),
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    },
  }
}

/** Run an internal Git command and return its stdout exactly as written. */
export async function internalGitRaw(
  cwd: string,
  args: string[],
  options: InternalGitOptions = {},
): Promise<string> {
  const prepared = prepare(cwd, args, options)
  const { stdout } = await execFileAsync('git', prepared.args, {
    ...prepared.options,
    encoding: 'utf8',
  })
  return stdout
}

/** Run an internal Git command and return its trimmed stdout. */
export async function internalGit(
  cwd: string,
  args: string[],
  options: InternalGitOptions = {},
): Promise<string> {
  return (await internalGitRaw(cwd, args, options)).trim()
}

/** Run an internal Git command whose stdout is binary (a `diff --binary` patch). */
export async function internalGitBuffer(
  cwd: string,
  args: string[],
  options: InternalGitOptions = {},
): Promise<Buffer> {
  const prepared = prepare(cwd, args, options)
  const { stdout } = await execFileAsync('git', prepared.args, {
    ...prepared.options,
    encoding: 'buffer',
  })
  return stdout
}
