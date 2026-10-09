import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCommand, type CommandResult } from './exec/command-runner.ts'
import { changedPaths } from './git-status-paths.ts'
import {
  worktreeManagerSandboxOverlay,
  worktreeReadOnlySandboxOverlay,
} from '../project-sandbox/worktree-config.ts'

/**
 * Submodules in thread worktrees.
 *
 * A linked checkout starts with every submodule directory empty. Populating
 * one the way `git submodule update` does would fetch from the network and run
 * the repository's configured update strategy, so instead each submodule the
 * project checkout has itself initialised is cloned from the project's own
 * module repository (`<common>/modules/<name>`): offline, with hardlinked
 * objects, into the thread's private `<common>/worktrees/<id>/modules/<name>`.
 * That is the layout Git itself produces, so the agent's sandbox, which
 * already owns the per-worktree admin directory, needs no further grant, and
 * the user's own module repositories are only ever read.
 *
 * The private clone is also what removal has to protect: `git worktree remove`
 * deletes it along with any commit the agent made inside a submodule.
 * {@link inspectSubmoduleRetention} names that work so callers can keep the
 * checkout, exactly as they keep a dirty or unmerged superproject.
 */

/** Pins the commit population checked out, so removal can tell it from the thread's own commits. */
const POPULATED_BASE_REF = 'refs/copse/submodule-base'
/** Nested submodules are followed this deep, matching no real repository's needs. */
const MAX_DEPTH = 8
/** Clone and checkout of a large submodule are bounded by its size, not by a probe budget. */
const POPULATE_TIMEOUT_MS = 300_000

interface WorktreeGitDirs {
  /** The checkout's own administration directory (`<common>/worktrees/<id>`). */
  gitDir: string
  commonGitDir: string
}

/**
 * Git in `cwd` (the thread checkout, a submodule inside it, or a module
 * repository in its administration directory), sandboxed as the enclosing
 * thread checkout. The manager overlay cannot be derived from a submodule
 * itself: its `.git` names a standalone repository, not a linked worktree.
 */
async function runGit(
  checkout: string,
  cwd: string,
  args: string[],
  access: 'read' | 'write',
  options: { timeoutMs?: number; stdoutMaxBytes?: number } = {},
): Promise<CommandResult> {
  return runCommand('git', args, {
    cwd,
    sandboxConfig:
      access === 'read'
        ? await worktreeReadOnlySandboxOverlay(checkout)
        : await worktreeManagerSandboxOverlay(checkout),
    timeout_ms: options.timeoutMs ?? 60_000,
    ...(options.stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: options.stdoutMaxBytes }),
  })
}

function ownErrorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (ownErrorCode(error) === 'ENOENT' || ownErrorCode(error) === 'ENOTDIR') return null
    throw error
  }
}

/** A Git repository directory (not a checkout): what lives under `modules/`. */
async function isRepositoryDir(path: string): Promise<boolean> {
  const [head, objects] = await Promise.all([
    lstatOrNull(join(path, 'HEAD')),
    lstatOrNull(join(path, 'objects')),
  ])
  return Boolean(head?.isFile() && objects?.isDirectory())
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  if (!(await lstatOrNull(path))?.isDirectory()) return false
  return (await readdir(path)).length === 0
}

async function worktreeGitDirs(checkout: string): Promise<WorktreeGitDirs> {
  const dotGit = join(checkout, '.git')
  const stat = await lstat(dotGit)
  if (stat.isDirectory()) return { gitDir: dotGit, commonGitDir: dotGit }
  const match = /^gitdir:\s*(.+?)\s*$/i.exec((await readFile(dotGit, 'utf8')).trim())
  if (!match?.[1]) throw new Error('Invalid Git worktree pointer')
  const gitDir = resolve(checkout, match[1])
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').catch((error: unknown) => {
    if (ownErrorCode(error) === 'ENOENT') return null
    throw error
  })
  return { gitDir, commonGitDir: common?.trim() ? resolve(gitDir, common.trim()) : gitDir }
}

/**
 * Git's own rule for a submodule name (`check_submodule_name`): the name
 * becomes a path under `modules/`, so no component may climb out of it.
 */
function isSafeModuleName(name: string): boolean {
  return name.length > 0 && !isAbsolute(name) && !name.split(/[\\/]/).includes('..')
}

/**
 * `path → name` for the submodules a `.gitmodules` declares. An absent or
 * empty file (Linux sandboxes can briefly leave an empty deny-path placeholder
 * there) declares none, and spawns nothing.
 */
async function declaredSubmodules(
  checkout: string,
  workTree: string,
): Promise<Map<string, string>> {
  const declared = new Map<string, string>()
  const file = await lstatOrNull(join(workTree, '.gitmodules'))
  if (!file?.isFile() || file.size === 0) return declared
  const result = await runGit(
    checkout,
    workTree,
    ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'],
    'read',
  )
  // Exit 1 means no key matched.
  if (result.code !== 0) return declared
  for (const record of result.stdout.split('\0')) {
    const newline = record.indexOf('\n')
    if (newline < 0) continue
    const key = record.slice(0, newline)
    const path = record.slice(newline + 1)
    const name = key.slice('submodule.'.length, -'.path'.length)
    if (path) declared.set(path, name)
  }
  return declared
}

/** The commits `treeish` records at the declared submodule paths. */
async function recordedGitlinks(
  checkout: string,
  workTree: string,
  treeish: string,
  paths: string[],
): Promise<Map<string, string>> {
  const gitlinks = new Map<string, string>()
  if (paths.length === 0) return gitlinks
  const result = await runGit(
    checkout,
    workTree,
    ['ls-tree', '-z', treeish, '--', ...paths],
    'read',
  )
  if (result.code !== 0) return gitlinks
  for (const record of result.stdout.split('\0')) {
    // <mode> SP <type> SP <object> TAB <path>
    const match = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/s.exec(record)
    if (match?.[1] && match[2]) gitlinks.set(match[2], match[1])
  }
  return gitlinks
}

interface PopulateLevel {
  checkout: string
  workTree: string
  /** The submodule path of `workTree` within the thread checkout, for messages. */
  label: string
  /** Where this level's own submodules keep their repositories. */
  moduleDir: string
  /** The project's repository for the same level, whose `modules/` is the clone source. */
  sourceModuleDir: string
  treeish: string
}

async function populateLevel(level: PopulateLevel, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return
  const declared = await declaredSubmodules(level.checkout, level.workTree)
  const gitlinks = await recordedGitlinks(level.checkout, level.workTree, level.treeish, [
    ...declared.keys(),
  ])
  for (const [path, commit] of gitlinks) {
    const name = declared.get(path)
    const label = level.label ? `${level.label}/${path}` : path
    if (name === undefined || !isSafeModuleName(name)) {
      console.warn(`[worktree] Not populating submodule ${label}: unsafe submodule name`)
      continue
    }
    const source = join(level.sourceModuleDir, 'modules', name)
    // A submodule the project checkout never initialised stays uninitialised:
    // fetching it is a network operation the user has not asked for.
    if (!(await isRepositoryDir(source))) continue
    const target = join(level.workTree, path)
    const gitDir = join(level.moduleDir, 'modules', name)
    // Only an empty, unpopulated directory is populated, so the cleanup below
    // can never delete anything population did not itself create.
    if (!(await isEmptyDirectory(target)) || (await lstatOrNull(gitDir))) continue
    try {
      await mkdir(dirname(gitDir), { recursive: true })
      const steps: [string, string[]][] = [
        [
          level.workTree,
          [
            'clone',
            '--no-checkout',
            '--template=',
            '--separate-git-dir',
            gitDir,
            '--',
            source,
            target,
          ],
        ],
        [target, ['switch', '--quiet', '--detach', commit]],
        [target, ['update-ref', POPULATED_BASE_REF, commit]],
      ]
      for (const [cwd, args] of steps) {
        const result = await runGit(level.checkout, cwd, args, 'write', {
          timeoutMs: POPULATE_TIMEOUT_MS,
        })
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout).trim() || `git ${args[0] ?? ''} failed`)
        }
      }
      // Point the clone where `git submodule update` would have: the project's
      // own upstream for it, not the local repository it was copied from.
      const upstream = await runGit(
        level.checkout,
        target,
        ['config', '--file', join(source, 'config'), '--get', 'remote.origin.url'],
        'read',
      )
      const url = upstream.stdout.trim()
      if (upstream.code === 0 && url) {
        await runGit(level.checkout, target, ['config', 'remote.origin.url', url], 'write')
      }
    } catch (error) {
      console.warn(`[worktree] Could not populate submodule ${label}: ${String(error)}`)
      // Leave the ordinary uninitialised state, not a half-made repository
      // that removal would then have to account for.
      await rm(gitDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(target, { recursive: true }).catch(() => undefined)
      continue
    }
    await populateLevel(
      {
        checkout: level.checkout,
        workTree: target,
        label,
        moduleDir: gitDir,
        sourceModuleDir: source,
        treeish: 'HEAD',
      },
      depth + 1,
    )
  }
}

/**
 * Check out, in a new thread checkout, every submodule the project checkout
 * has initialised, at the commit `treeish` records (the seeded snapshot, so a
 * dirty project's moved submodule pointer carries over). Best effort: it never
 * throws, and a submodule that cannot be populated is left uninitialised for
 * the agent to set up itself. Uncommitted changes inside the project's own
 * submodules are not carried.
 */
export async function populateWorktreeSubmodules(
  checkout: string,
  treeish = 'HEAD',
): Promise<void> {
  try {
    const { gitDir, commonGitDir } = await worktreeGitDirs(checkout)
    await populateLevel(
      {
        checkout,
        workTree: checkout,
        label: '',
        moduleDir: gitDir,
        sourceModuleDir: commonGitDir,
        treeish,
      },
      0,
    )
  } catch (error) {
    console.warn(`[worktree] Could not populate submodules: ${String(error)}`)
  }
}

/** Module repositories under `dir/modules`, keyed by their path below it. */
async function moduleRepositories(dir: string, prefix = '', depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH * 4) return []
  const modules = join(dir, 'modules')
  let entries: string[]
  try {
    entries = await readdir(join(modules, prefix))
  } catch (error) {
    if (ownErrorCode(error) === 'ENOENT' || ownErrorCode(error) === 'ENOTDIR') return []
    throw error
  }
  const found: string[] = []
  for (const entry of entries.sort()) {
    const relative = prefix ? `${prefix}/${entry}` : entry
    const path = join(modules, relative)
    const stat = await lstat(path)
    if (!stat.isDirectory()) continue
    if (await isRepositoryDir(path)) {
      found.push(relative)
      // A module repository holds its own nested submodules' repositories.
      for (const nested of await moduleRepositories(path, '', depth + 1)) {
        found.push(`${relative}/modules/${nested}`)
      }
    } else {
      // Submodule names may contain slashes: keep descending.
      found.push(...(await moduleRepositories(dir, relative, depth + 1)))
    }
  }
  return found
}

/** HEAD and branch tips that nothing outside the thread's private module repository holds. */
async function unpreservedTips(checkout: string, repository: string): Promise<string[] | null> {
  const [head, branches] = await Promise.all([
    runGit(checkout, repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 'read'),
    runGit(checkout, repository, ['for-each-ref', '--format=%(objectname)', 'refs/heads'], 'read'),
  ])
  if (branches.code !== 0) return null
  const tips = new Set(
    [head.code === 0 ? head.stdout : '', branches.stdout]
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const unpreserved: string[] = []
  for (const tip of [...tips].sort()) {
    // Reachable from the commit population copied out of the project
    // (`refs/copse`) or from a remote-tracking ref (the project's branches at
    // clone time, or upstream once fetched or pushed to): the commit exists
    // outside this clone. A tag does not count; one made here dies with it.
    const holder = await runGit(
      checkout,
      repository,
      [
        'for-each-ref',
        '--count=1',
        '--format=%(refname)',
        '--contains',
        tip,
        'refs/remotes',
        'refs/copse',
      ],
      'read',
    )
    if (holder.code !== 0) return null
    if (!holder.stdout.trim()) unpreserved.push(tip)
  }
  return unpreserved
}

/** Populated submodule checkouts below `workTree`, as `[label, path]`. */
async function populatedCheckouts(
  checkout: string,
  workTree: string,
  label: string,
  depth: number,
): Promise<[string, string][]> {
  if (depth > MAX_DEPTH) return []
  const found: [string, string][] = []
  for (const path of (await declaredSubmodules(checkout, workTree)).keys()) {
    const target = join(workTree, path)
    if (!(await lstatOrNull(join(target, '.git')))) continue
    const nestedLabel = label ? `${label}/${path}` : path
    found.push([nestedLabel, target])
    found.push(...(await populatedCheckouts(checkout, target, nestedLabel, depth + 1)))
  }
  return found
}

export interface SubmoduleRetention {
  /** Changed, untracked, or (when asked) ignored files inside submodule checkouts. */
  paths: string[]
  /**
   * Module repositories, by submodule name, holding commits nothing outside
   * this checkout preserves. Removing the checkout would discard them.
   */
  modules: { name: string; tips: string[] }[]
}

/**
 * What removing `checkout` would destroy inside its submodules, beyond what
 * the superproject's own `git status --ignore-submodules=none` reports. A
 * checkout without submodules costs one `lstat` and no Git process. Anything
 * that cannot be inspected is reported as retained, never as safe.
 */
export async function inspectSubmoduleRetention(
  checkout: string,
  options: { includeIgnored: boolean },
): Promise<SubmoduleRetention> {
  const retention: SubmoduleRetention = { paths: [], modules: [] }
  const { gitDir } = await worktreeGitDirs(checkout)
  for (const [label, target] of await populatedCheckouts(checkout, checkout, '', 0)) {
    const status = await runGit(
      checkout,
      target,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        ...(options.includeIgnored ? ['--ignored=matching'] : []),
      ],
      'read',
    )
    if (status.code !== 0) {
      retention.paths.push(label)
      continue
    }
    for (const path of changedPaths(status.stdout)) retention.paths.push(`${label}/${path}`)
  }
  for (const name of await moduleRepositories(gitDir)) {
    const tips = await unpreservedTips(checkout, join(gitDir, 'modules', name))
    if (tips === null) retention.modules.push({ name, tips: [] })
    else if (tips.length > 0) retention.modules.push({ name, tips })
  }
  return retention
}

/** Retained paths for a blocked-removal result: changed files, then repositories by name. */
export function submoduleRetentionPaths(retention: SubmoduleRetention): string[] {
  return [...retention.paths, ...retention.modules.map((module) => module.name)]
}

/**
 * Whether `git worktree remove` refuses `checkout` only for the module
 * repositories Copse keeps in its administration directory, which
 * {@link inspectSubmoduleRetention} accounts for. Any gitlink in the index
 * whose checkout carries its own `.git` directory (a repository the agent
 * cloned and added itself, declared or not) is history nothing has inspected,
 * so it never qualifies, and neither does an index that cannot be read whole.
 */
export async function holdsOnlyAbsorbedSubmodules(checkout: string): Promise<boolean> {
  const { gitDir } = await worktreeGitDirs(checkout)
  if (!(await lstatOrNull(join(gitDir, 'modules')))?.isDirectory()) return false
  const index = await runGit(checkout, checkout, ['ls-files', '--stage', '-z'], 'read', {
    stdoutMaxBytes: 64 * 1024 * 1024,
  })
  if (index.code !== 0 || index.stdoutTruncated) return false
  for (const record of index.stdout.split('\0')) {
    // <mode> SP <object> SP <stage> TAB <path>
    const path = /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(record)?.[1]
    if (path && (await lstatOrNull(join(checkout, path, '.git')))?.isDirectory()) return false
  }
  return true
}
