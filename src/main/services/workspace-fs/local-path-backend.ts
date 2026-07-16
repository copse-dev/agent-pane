import { realpathSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import type { PathBackend } from './path-backend.ts'

/** Local disk backend — wraps `node:fs/promises` for workspace path resolution. */
export const localPathBackend: PathBackend = {
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  },

  async stat(path: string): Promise<{ isDirectory(): boolean }> {
    const stat = await fsp.stat(path)
    return { isDirectory: () => stat.isDirectory() }
  },

  async lstat(path: string): Promise<{ isSymbolicLink(): boolean }> {
    const stat = await fsp.lstat(path)
    return { isSymbolicLink: () => stat.isSymbolicLink() }
  },

  readlink(path: string): Promise<string> {
    return fsp.readlink(path)
  },

  realpath(path: string): Promise<string> {
    // Match the pre-3a sync helpers (`realpathSync.native`) for macOS symlink
    // canonicalization (/var → /private/var); `fsp.realpath` can diverge.
    return Promise.resolve(realpathSync.native(path))
  },
}
