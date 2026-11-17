import { access } from 'node:fs/promises'

/**
 * Whether `path` names something that exists, following symlinks: a dangling
 * link reports `false`. Any failure (missing, unsearchable parent, bad path)
 * counts as absent, so a caller that must tell "missing" from "inaccessible",
 * or must not follow a final symlink, should call `access`/`lstat` itself.
 * Node-only.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
