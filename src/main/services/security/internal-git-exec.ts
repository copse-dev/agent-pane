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
 * Every operation here reads or writes local files (bundles, sibling
 * checkouts), so `file` is the only transport, `fetch` and `push` included.
 * Otherwise a checkout's `url.<base>.insteadOf` could rewrite a bundle path into
 * an `ssh://` remote and Git would run that checkout's `core.sshCommand`.
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
        internalGitTransport(args[0]) === 'none' ? 'none' : 'local',
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

/**
 * Shown when a bundle needs history that a partial clone never downloaded.
 * Internal Git does not fetch it on demand (`GIT_NO_LAZY_FETCH`): that fetch
 * would run with the checkout's own transport and credential configuration.
 */
export const PARTIAL_CLONE_BUNDLE_MESSAGE =
  "This checkout is a partial clone, so some of its history isn't downloaded, and Copse doesn't download it automatically. Run `git backfill` in the checkout (Git 2.49 or later) or use a full clone, then try again."

/** Whether `cwd` is a partial clone: some remote promises objects it may omit. */
async function isPartialClone(cwd: string): Promise<boolean> {
  const extension = await internalGit(cwd, ['config', '--get', 'extensions.partialClone']).catch(
    () => '',
  )
  if (extension) return true
  const promisors = await internalGit(cwd, [
    'config',
    '--get-regexp',
    String.raw`^remote\..*\.promisor$`,
  ]).catch(() => '')
  return promisors.split('\n').some((line) => /\strue$/i.test(line))
}

/**
 * `git bundle create <bundlePath> <revs...>` for carry-in and hosted transfer.
 * A partial clone whose bundled history includes objects it never downloaded
 * fails with an opaque promisor error; that case gets
 * {@link PARTIAL_CLONE_BUNDLE_MESSAGE} instead, with Git's error as the cause.
 */
export async function internalGitBundleCreate(
  cwd: string,
  bundlePath: string,
  revs: readonly string[],
): Promise<void> {
  try {
    await internalGit(cwd, ['bundle', 'create', bundlePath, ...revs])
  } catch (error) {
    if (await isPartialClone(cwd)) throw new Error(PARTIAL_CLONE_BUNDLE_MESSAGE, { cause: error })
    throw error
  }
}
