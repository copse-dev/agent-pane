import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand, type CommandResult } from './exec/command-runner.ts'
import { copseCacheDir } from './storage/copse-paths.ts'

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
) => Promise<CommandResult>

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
export async function fetchThroughScratchRepository(input: {
  projectRoot: string
  url: string
  refs: readonly ScratchFetchRef[]
  scratch: string
  projectGit: ProjectGit
}): Promise<CommandResult> {
  const { projectRoot, url, refs, scratch, projectGit } = input
  if (refs.length === 0) return failed('No refs to fetch')
  const [commonDir, ...seeds] = await Promise.all([
    projectGit(projectRoot, ['rev-parse', '--git-common-dir']),
    ...refs.map(({ destination }) =>
      projectGit(projectRoot, ['rev-parse', '--verify', '--quiet', `${destination}^{commit}`]),
    ),
  ])
  if (!commonDir) return failed('Project Git directory lookup failed')
  if (commonDir.code !== 0) return commonDir
  const objects = join(resolve(projectRoot, commonDir.stdout.trim()), 'objects')
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
        // Enforce the network boundary after global URL rewrites, too. The
        // sandboxed local copy below still needs its ordinary file transport.
        gitConfig: args[0] === 'fetch' && isNetworkRemoteUrl(url) ? 'internal-network' : 'internal',
      })
    const init = await host(['init', '--bare', '--quiet', '--template=', scratch])
    if (init.code !== 0) return init
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${objects}\n`)
    // The project's last fetched tips give the negotiation a starting point, so
    // only commits since then are downloaded.
    for (const [index, { destination }] of refs.entries()) {
      const seed = seeds[index]
      const seedCommit = seed?.code === 0 ? seed.stdout.trim() : ''
      if (!seedCommit) continue
      const update = await host(['update-ref', destination, seedCommit])
      if (update.code !== 0) return update
    }
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
    await rm(scratch, { recursive: true, force: true })
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
): Promise<CommandResult | null> {
  const url = await networkOriginUrl(projectRoot, projectGit)
  if (url === null) return null
  const parent = join(copseCacheDir(), 'default-branch-fetch')
  await mkdir(parent, { recursive: true })
  // The sandbox rejects redirected grants, so name the scratch by its real path.
  const id = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
  const scratch = join(await realpath(parent), `${id}${scratchSuffix}.git`)
  return fetchThroughScratchRepository({ projectRoot, url, refs, scratch, projectGit })
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
  return fetchFromOriginOnHost(projectRoot, [originBranchRef(branch)], projectGit)
}
