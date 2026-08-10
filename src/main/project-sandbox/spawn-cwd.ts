import { stat } from 'node:fs/promises'

/**
 * Whether a child can still be spawned with `cwd` as its working directory.
 *
 * A checkout can disappear under a running app — a deleted scratch worktree, an
 * unmounted volume — while the persisted project record naming it survives.
 * libuv reports the forked child's failed `chdir` as ENOENT against the
 * *executable*, so that surfaced as `spawn /bin/bash ENOENT` for a shell that
 * plainly exists, and the rejected error dragged the entire sandbox argv
 * (proxy credentials included) into the log. Probing first lets callers fail
 * with the directory that is actually missing, or degrade instead of throwing.
 *
 * An empty `cwd` inherits this process's directory, which cannot fail this way.
 */
export async function isSpawnableWorkingDirectory(cwd: string): Promise<boolean> {
  if (!cwd) return true
  try {
    return (await stat(cwd)).isDirectory()
  } catch {
    return false
  }
}
