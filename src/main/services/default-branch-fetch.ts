import { sha256Hex } from '@copse/std/sha256.ts'
import { copyFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand, type CommandResult } from './exec/command-runner.ts'
import { copseCacheDir } from './storage/copse-paths.ts'
import type { GitAuthMode } from './ssh-workspace/git-ssh-env.ts'

/**
 * Background refresh of a project's `origin/<default>` ref, outside the project
 * sandbox.
 *
 * Worktree bookkeeping Git runs in a sandbox with no network and no `~/.ssh`,
 * so a fetch there can never reach a real remote. Granting that sandbox the
 * network and the user's credentials would hand them to whatever the project's
 * own `.git/config` names (credential helpers, `url.*.insteadOf`, upload-pack,
 * remote helpers). Instead the network step runs in a Copse-owned scratch bare
 * repository: its config is empty, so only the user's global/system Git config
 * applies — the same as running `git fetch` in a terminal outside any project.
 * The scratch repository borrows the project's objects through `alternates`,
 * so only new objects travel. A second, sandboxed, local-only fetch then copies
 * the tip into the project. Only `refs/remotes/origin/<branch>` moves; the
 * checkout and local branches are never touched.
 */

/** A project-scoped Git runner: the worktree manager's sandboxed `runWorktreeGit`. */
export type ProjectGit = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  extraWritePaths?: string[],
  stdoutMaxBytes?: number,
  gitAuth?: GitAuthMode,
) => Promise<CommandResult>

/** Keep every project-side step of opportunistic refresh unattended too. */
export function noninteractiveProjectGit(projectGit: ProjectGit): ProjectGit {
  return (cwd, args, env, extraWritePaths, stdoutMaxBytes) =>
    projectGit(cwd, args, env, extraWritePaths, stdoutMaxBytes, 'noninteractive')
}

/**
 * Remote URLs the host-side fetch may contact: network transports only.
 * Local paths and `file://` keep the sandboxed fetch. A leading `-` or any
 * `::` (remote-helper syntax) is refused outright.
 */
export function isNetworkRemoteUrl(url: string): boolean {
  if (url.startsWith('-') || url.includes('::') || /\s/.test(url)) return false
  if (/^(https?|ssh):\/\/[^/]/i.test(url)) return true
  // scp-like `user@host:path`.
  return /^[\w.-]+@[\w.-]+:/.test(url)
}

function failed(message: string): CommandResult {
  return { stdout: '', stderr: message, code: 1, stdoutTruncated: false }
}

/**
 * Host-side scratch fetches run unsandboxed in their own process group, so the
 * app exiting does not end them: an orphaned `git fetch` (with its
 * `git-remote-https` and `index-pack`) used to run on for tens of seconds,
 * skip its scratch cleanup, and keep any inherited sockets open (#4407).
 * Quit cleanup aborts them through this controller.
 */
const scratchFetchAbort = new AbortController()
const scratchFetchesInFlight = new Set<Promise<unknown>>()

/** How long quit cleanup waits for aborted fetches to exit and remove their scratch. */
export const SCRATCH_FETCH_ABORT_WAIT_MS = 5_000

/**
 * Kill every in-flight host-side scratch fetch and refuse new ones; for quit
 * cleanup. Resolves once they have removed their scratch repositories, or
 * after `waitMs`.
 */
export async function abortScratchFetchesForQuit(
  waitMs = SCRATCH_FETCH_ABORT_WAIT_MS,
): Promise<void> {
  scratchFetchAbort.abort()
  if (scratchFetchesInFlight.size === 0) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled([...scratchFetchesInFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
}

/** Scratch-only ref holding the project's HEAD, offered as a negotiation tip. */
const SCRATCH_SEED_HEAD_REF = 'refs/copse-seed/HEAD'

/** One ref to fetch: `source` on the remote, written to `destination` here. */
export interface ScratchFetchRef {
  source: string
  destination: string
}

/** `refs/heads/<branch>` on origin into `refs/remotes/origin/<branch>`. */
export function originBranchRef(branch: string): ScratchFetchRef {
  return { source: `refs/heads/${branch}`, destination: `refs/remotes/origin/${branch}` }
}

/**
 * Fetch `refs` from `url` through a fresh scratch repository at `scratch` and
 * copy them into the project. Callers choose sources and destinations from
 * validated names; this never derives a refspec from Git configuration.
 * Resolves with the first failing command's result, or the final copy's.
 */
export function fetchThroughScratchRepository(input: {
  projectRoot: string
  url: string
  refs: readonly ScratchFetchRef[]
  scratch: string
  projectGit: ProjectGit
  gitAuth?: GitAuthMode
}): Promise<CommandResult> {
  if (scratchFetchAbort.signal.aborted) return Promise.resolve(failed('Copse is quitting'))
  const run = fetchThroughScratchRepositoryOnce(input, scratchFetchAbort.signal)
  scratchFetchesInFlight.add(run)
  void run.then(
    () => scratchFetchesInFlight.delete(run),
    () => scratchFetchesInFlight.delete(run),
  )
  return run
}

async function fetchThroughScratchRepositoryOnce(
  input: Parameters<typeof fetchThroughScratchRepository>[0],
  signal: AbortSignal,
): Promise<CommandResult> {
  const { projectRoot, url, refs, scratch, projectGit, gitAuth = 'interactive' } = input
  if (refs.length === 0) return failed('No refs to fetch')
  const [commonDir, head, ...seeds] = await Promise.all([
    projectGit(projectRoot, ['rev-parse', '--git-common-dir']),
    projectGit(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    ...refs.map(({ destination }) =>
      projectGit(projectRoot, ['rev-parse', '--verify', '--quiet', `${destination}^{commit}`]),
    ),
  ])
  if (commonDir.code !== 0) return commonDir
  const gitDir = resolve(projectRoot, commonDir.stdout.trim())
  const objects = join(gitDir, 'objects')
  // `alternates` is one path per line.
  if (objects.includes('\n')) return failed('Project object directory path is not supported')

  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  try {
    // Host side: a repository whose only configuration is Copse's own.
    const host = (args: string[]): Promise<CommandResult> =>
      runCommand('git', args, {
        cwd: scratch,
        unsandboxed: true,
        timeout_ms: 60_000,
        signal,
        // Enforce the network boundary after global URL rewrites, too. The
        // sandboxed local copy below still needs its ordinary file transport.
        gitConfig: args[0] === 'fetch' && isNetworkRemoteUrl(url) ? 'internal-network' : 'internal',
        gitAuth,
      })
    const init = await host(['init', '--bare', '--quiet', '--template=', scratch])
    if (init.code !== 0) return init
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${objects}\n`)
    // The project's last fetched tips, and its HEAD, give the negotiation a
    // starting point, so only commits since then are downloaded. Internal Git
    // sets `core.alternateRefsCommand=`, which keeps the alternate's own refs
    // out of the negotiation; without a seeded tip the fetch would announce
    // no objects at all and download the remote's whole history (#4407). HEAD
    // matters when the project has never fetched `<destination>`, as in a CI
    // checkout of one commit.
    const seedUpdates: [ref: string, commit: string][] = []
    for (const [index, { destination }] of refs.entries()) {
      const seed = seeds[index]
      const seedCommit = seed?.code === 0 ? seed.stdout.trim() : ''
      if (seedCommit) seedUpdates.push([destination, seedCommit])
    }
    const headCommit = head.code === 0 ? head.stdout.trim() : ''
    if (headCommit) seedUpdates.push([SCRATCH_SEED_HEAD_REF, headCommit])
    for (const [ref, commit] of seedUpdates) {
      const update = await host(['update-ref', ref, commit])
      if (update.code !== 0) return update
    }
    // A shallow project lacks its seeds' ancestors. Sharing its shallow
    // boundary tells the remote so, instead of a thin pack whose delta bases
    // the scratch cannot resolve. The scratch is then itself shallow, so the
    // project-side copy below reads from a shallow repository; Git handles
    // that, and dropping this copy brings back the failing fetch.
    await copyFile(join(gitDir, 'shallow'), join(scratch, 'shallow')).catch((error: unknown) => {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    })
    const fetched = await host([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-recurse-submodules',
      '--end-of-options',
      url,
      ...refs.map(({ source, destination }) => `+${source}:${destination}`),
    ])
    if (fetched.code !== 0) return fetched

    // Project side: local-only, inside the project sandbox as before.
    return await projectGit(
      projectRoot,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--end-of-options',
        scratch,
        ...refs.map(({ destination }) => `+${destination}:${destination}`),
      ],
      undefined,
      [scratch],
    )
  } finally {
    // An aborted fetch can still be writing for a moment while its group exits.
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * The project's `remote.origin.url` when it is a network remote the host may
 * fetch, else `null`. The raw configured URL: the project's own `insteadOf`
 * rewrites do not apply here; the user's global ones do, inside the scratch
 * repository.
 */
export async function networkOriginUrl(
  projectRoot: string,
  projectGit: ProjectGit,
): Promise<string | null> {
  const configured = await projectGit(projectRoot, [
    'config',
    '--local',
    '--get',
    'remote.origin.url',
  ])
  const url = configured.code === 0 ? configured.stdout.trim() : ''
  return isNetworkRemoteUrl(url) ? url : null
}

/**
 * Host-side fetch of `refs` from the project's network origin, or `null` when
 * the origin is not a network remote. `scratchSuffix` separates concurrent
 * callers that may fetch for one project at the same time.
 */
export async function fetchFromOriginOnHost(
  projectRoot: string,
  refs: readonly ScratchFetchRef[],
  projectGit: ProjectGit,
  scratchSuffix = '',
  gitAuth: GitAuthMode = 'interactive',
): Promise<CommandResult | null> {
  const url = await networkOriginUrl(projectRoot, projectGit)
  if (url === null) return null
  const parent = join(copseCacheDir(), 'default-branch-fetch')
  await mkdir(parent, { recursive: true })
  // The sandbox rejects redirected grants, so name the scratch by its real path.
  const id = sha256Hex(projectRoot).slice(0, 16)
  const scratch = join(await realpath(parent), `${id}${scratchSuffix}.git`)
  return fetchThroughScratchRepository({ projectRoot, url, refs, scratch, projectGit, gitAuth })
}

/**
 * Host-side fetch of `origin/<branch>` for `projectRoot`, or `null` when the
 * origin is not a network remote and the caller should keep its sandboxed fetch.
 */
export function fetchDefaultBranchFromHost(
  projectRoot: string,
  branch: string,
  projectGit: ProjectGit,
): Promise<CommandResult | null> {
  // Only opportunistic refresh is unattended. Explicit git_fetch shares the
  // scratch helper but retains its ordinary authentication bridge.
  return fetchFromOriginOnHost(
    projectRoot,
    [originBranchRef(branch)],
    noninteractiveProjectGit(projectGit),
    '',
    'noninteractive',
  )
}
