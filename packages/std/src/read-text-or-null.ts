import { readFileSync } from 'node:fs'

/**
 * Read `path` as UTF-8, or `null` when it cannot be read for any reason
 * (missing, a directory, unreadable). Follows symlinks. A caller that must tell
 * "missing" from "unreadable", or must refuse a symlink, should read the file
 * itself. Node-only.
 */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
