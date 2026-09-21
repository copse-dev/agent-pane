import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { readOnlyWorkspaceSandboxOverlay, workspaceSandboxOverlay } from './config.ts'

/** Find Git metadata without executing Git or following repository configuration. */
async function repositoryPaths(cwd: string): Promise<{
  checkout: string
  gitDir: string
  commonDir: string
} | null> {
  let checkout = await realpath(cwd)
  for (;;) {
    const dotGit = join(checkout, '.git')
    const stat = await lstat(dotGit).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isDirectory()) return { checkout, gitDir: dotGit, commonDir: dotGit }
    if (stat?.isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/i.exec((await readFile(dotGit, 'utf8')).trim())
      if (!match?.[1]) throw new Error('Invalid Git worktree pointer')
      const gitDir = await realpath(resolve(checkout, match[1]))
      const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
      if (!common) throw new Error('Linked worktree has no common Git directory')
      const commonDir = await realpath(resolve(gitDir, common))
      if (dirname(gitDir) !== join(commonDir, 'worktrees')) {
        throw new Error('Invalid linked worktree Git directory')
      }
      const backlink = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()
      if ((await realpath(backlink)) !== (await realpath(dotGit))) {
        throw new Error('Git administration does not belong to this checkout')
      }
      return { checkout, gitDir, commonDir }
    }
    if (stat) throw new Error('Unsupported .git entry')
    const parent = dirname(checkout)
    if (parent === checkout) return null
    checkout = parent
  }
}

/** Canonicalize the existing parent of a checkout that has not been created yet. */
async function canonicalFuturePath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonicalFuturePath(parent), basename(absolute))
  }
}

/**
 * Host-only worktree management needs the checkout, its Git administration, and
 * the particular destination selected by the manager. Never grant the whole
 * managed-worktrees directory or drop network/home containment to obtain this.
 * extraWritePaths must come from validated manager paths, not Git config/argv.
 */
export async function worktreeManagerSandboxOverlay(
  cwd: string,
  extraWritePaths: string[] = [],
  writeConfig = false,
): Promise<Partial<SandboxRuntimeConfig>> {
  const repository = await repositoryPaths(cwd)
  const base = workspaceSandboxOverlay(repository?.checkout ?? cwd)
  const fs = base.filesystem
  if (!fs) throw new Error('Missing worktree sandbox filesystem policy')
  const extra = await Promise.all(
    extraWritePaths.map(async (path) => {
      const canonical = await canonicalFuturePath(path)
      if (canonical !== resolve(path)) throw new Error('Worktree destination is redirected')
      return canonical
    }),
  )
  const metadata = repository
    ? [join(repository.checkout, '.git'), repository.gitDir, repository.commonDir]
    : []
  const writes = repository
    ? [
        repository.gitDir,
        ...['objects', 'refs', 'logs', 'worktrees', 'packed-refs'].map((name) =>
          join(repository.commonDir, name),
        ),
      ]
    : []
  // ASRT canonicalizes grants. Never let a repo symlink turn objects/refs/etc.
  // into a write grant for its target outside the Git administration directory.
  if (repository) {
    // Git updates config by writing config.lock and renaming it over config.
    // On Linux, binding the individual config file makes it a mount point and
    // that rename fails with EBUSY. The only callers that enable writeConfig
    // are pinned `git config --local branch.*.copse-worktree-recovery …` and
    // `git branch -d …` commands; grant their validated common admin directory
    // while the deny list below continues to protect hooks/config.worktree.
    if (writeConfig) writes.push(repository.commonDir)
    for (const path of writes) {
      if ((await canonicalFuturePath(path)) !== path)
        throw new Error('Git metadata write path is redirected')
    }
  }
  const protectedMetadata = metadata.flatMap((dir) => [
    ...(!writeConfig ? [join(dir, 'config')] : []),
    join(dir, 'config.worktree'),
    join(dir, 'hooks'),
    join(dir, 'hooks/**'),
  ])
  return {
    ...base,
    filesystem: {
      ...fs,
      allowRead: [...(fs.allowRead ?? []), ...metadata, ...extra],
      allowWrite: [...fs.allowWrite, ...writes, ...extra],
      denyWrite: [
        ...fs.denyWrite.filter(
          (path) => !writeConfig || path !== join(repository?.commonDir ?? '', 'config'),
        ),
        ...protectedMetadata,
      ],
    },
  }
}

/**
 * Read-only manager commands need no checkout or metadata write grants. Keeping
 * denyWrite empty is significant on Linux: bubblewrap realizes those denies as
 * mount placeholders, which status/snapshot checks would mistake for worktree
 * content. Snapshot verification may additionally write its throwaway index.
 */
export async function worktreeReadOnlySandboxOverlay(
  cwd: string,
  extraWritePaths: string[] = [],
): Promise<Partial<SandboxRuntimeConfig>> {
  const repository = await repositoryPaths(cwd)
  const base = readOnlyWorkspaceSandboxOverlay(repository?.checkout ?? cwd)
  const fs = base.filesystem
  if (!fs) throw new Error('Missing read-only worktree sandbox filesystem policy')
  const extra = await Promise.all(
    extraWritePaths.map(async (path) => {
      const canonical = await canonicalFuturePath(path)
      if (canonical !== resolve(path)) throw new Error('Worktree scratch path is redirected')
      return canonical
    }),
  )
  const metadata = repository
    ? [join(repository.checkout, '.git'), repository.gitDir, repository.commonDir]
    : []
  return {
    ...base,
    filesystem: {
      ...fs,
      allowRead: [...(fs.allowRead ?? []), ...metadata, ...extra],
      allowWrite: extra,
      denyWrite: [],
    },
  }
}
