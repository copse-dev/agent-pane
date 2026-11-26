// The build's copy of an optional vendored binary tree (gortex, remote-watcher).
import { accessSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'

/**
 * Copy an optional vendored binary tree, dereferenced so a worktree symlink
 * into ~/.copse/cache becomes a real binary inside the packaged app (symlinks
 * would escape the bundle). The old copy goes first: an earlier build may have
 * left a symlink there, and `cp` will not dereference onto one
 * (ERR_FS_CP_EINVAL). Only a missing source is skipped; a failed copy fails
 * the build rather than leaving the old tree in place.
 */
export async function copyOptionalBinaries(
  source: string,
  required: string,
  dest: string,
): Promise<void> {
  try {
    accessSync(required)
  } catch {
    return
  }
  await rm(dest, { recursive: true, force: true })
  await cp(source, dest, { recursive: true, dereference: true })
}
