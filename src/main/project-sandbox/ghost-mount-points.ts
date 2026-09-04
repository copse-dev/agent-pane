import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatusResult } from '@shared/types/git.ts'

/**
 * Paths the Linux sandbox denies for *every* command in a workspace, whether or
 * not they exist. The ASRT bubblewrap backend implements a deny on a missing
 * file as `--ro-bind /dev/null <path>`, and bwrap creates that mount point as an
 * empty file on the host. ASRT removes them after the command — unless another
 * sandboxed command is still running, in which case removal is deferred
 * (deleting a live mount point detaches the other sandbox's deny). So while two
 * sandboxed commands overlap, a `git status` in between sees a burst of
 * zero-byte untracked dotfiles that no one wrote: `.bashrc`, `.gitconfig`,
 * `.claude/commands`, …
 *
 * The file names mirror `DANGEROUS_FILES` / `getDangerousDirectories()` in
 * `@anthropic-ai/sandbox-runtime` plus Copse's own additions in
 * `workspaceMandatoryWriteDenyPaths` (config.ts). Keep the two in step.
 */
const GHOST_MOUNT_POINT_PATHS: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
  '.cursor/agents',
  '.copse/agents',
]

const GHOST_PATH_SET = new Set(GHOST_MOUNT_POINT_PATHS)

/** Directories that hold nothing but ghost mount points once bwrap has run. */
const GHOST_PARENT_DIRS = new Set(
  GHOST_MOUNT_POINT_PATHS.filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/'))),
)

/**
 * What the filter needs to know about a path: whether it is a regular file and
 * its size, or a directory and whether anything is in it. `null` when the path
 * does not exist. Injectable so the decision logic is unit-testable without a
 * sandbox.
 */
export type GhostFileStat = (
  absolutePath: string,
) => { isFile: boolean; size: number; isDirectory: boolean; entries: number } | null

function defaultStat(
  absolutePath: string,
): { isFile: boolean; size: number; isDirectory: boolean; entries: number } | null {
  try {
    const stat = statSync(absolutePath)
    const isDirectory = stat.isDirectory()
    return {
      isFile: stat.isFile(),
      size: stat.size,
      isDirectory,
      entries: isDirectory ? readdirSync(absolutePath).length : 0,
    }
  } catch {
    return null
  }
}

/**
 * True when `relativePath` (workspace-relative, `/`-separated) is a bwrap mount
 * point rather than something someone created: it is one of the mandatory deny
 * paths and the entry on disk is a zero-byte regular file, an empty directory,
 * or already gone. A real `.bashrc` has content; a real `.vscode` or
 * `.claude/commands` has files in it. bwrap makes the directory-shaped targets
 * (`.claude/commands`, `.cursor/agents`, …) as empty directories, and ASRT's
 * cleanup only removes the file-shaped ones, so those empty directories
 * outlive the command. "Gone" counts because ASRT removes the files the moment
 * the last sandboxed command exits, which is after `git status` listed them and
 * before this check runs; an untracked record for a path that no longer exists
 * is not the user's either way.
 */
export function isGhostMountPoint(
  root: string,
  relativePath: string,
  stat: GhostFileStat = defaultStat,
): boolean {
  if (!GHOST_PATH_SET.has(relativePath)) return false
  const info = stat(join(root, relativePath))
  if (info === null) return true
  if (info.isFile) return info.size === 0
  return info.isDirectory && info.entries === 0
}

/**
 * Whether the untracked entry `relativePath` exists only because of ghost mount
 * points. Covers the file itself and the `.claude`/`.cursor`/`.copse` directory
 * records `git status` collapses them into when nothing else lives there.
 */
export function isGhostMountPointEntry(
  root: string,
  relativePath: string,
  stat: GhostFileStat = defaultStat,
  listDir: (absolutePath: string) => string[] | null = defaultListDir,
): boolean {
  if (isGhostMountPoint(root, relativePath, stat)) return true
  if (!GHOST_PARENT_DIRS.has(relativePath)) return false
  const children = listDir(join(root, relativePath))
  // The directory itself was a mount-point parent bwrap created and ASRT has
  // already removed; nothing of the user's was ever in it.
  if (children === null) return true
  if (children.length === 0) return false
  return children.every((child) => isGhostMountPoint(root, `${relativePath}/${child}`, stat))
}

function defaultListDir(absolutePath: string): string[] | null {
  try {
    return readdirSync(absolutePath)
  } catch {
    return null
  }
}

/**
 * Drop untracked ghost mount points from a status result. Only the Linux
 * sandbox creates them, and only untracked records can be ghosts (a tracked
 * file was committed by someone), so everything else passes through untouched.
 */
export function withoutGhostMountPoints(
  status: GitStatusResult,
  root: string,
  options: { platform?: NodeJS.Platform; stat?: GhostFileStat } = {},
): GitStatusResult {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') return status
  const stat = options.stat ?? defaultStat
  const unstaged = status.unstaged.filter(
    (change) => change.status !== 'untracked' || !isGhostMountPointEntry(root, change.path, stat),
  )
  return unstaged.length === status.unstaged.length ? status : { ...status, unstaged }
}
