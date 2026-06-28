import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Shared path-containment primitives used by the workspace path guards.
 *
 * Factored out of `workspace.ts` so the containment logic — the security
 * boundary that keeps file tools inside their allowed roots — can be unit
 * tested directly and reused for additional read-only roots (the app-owned
 * attachment store) without duplicating or weakening the workspace gate.
 */

export function isPathInsideRoot(resolved: string, absRoot: string): boolean {
  const rel = relative(absRoot, resolved)
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..'))
}

/**
 * Resolve symlinks on the longest existing prefix of `absPath`, then re-attach
 * the non-existent suffix. Lets a path that does not exist yet still be checked
 * against its real (symlink-resolved) location, defeating symlink-swap escapes.
 */
export function resolveThroughExistingPrefix(absPath: string): string {
  let probe = absPath
  while (true) {
    if (existsSync(probe)) {
      const realProbe = realpathSync.native(probe)
      const suffix = relative(probe, absPath)
      return suffix ? resolve(realProbe, suffix) : realProbe
    }
    const parent = dirname(probe)
    if (parent === probe) return absPath
    probe = parent
  }
}

/**
 * Resolve `path` against a single `root`, enforcing real-path containment at
 * every step (input, target, and the symlink-resolved target). Relative paths
 * are interpreted against `root`. Returns the resolved absolute path when it
 * stays inside `root`, or `null` when it escapes or `root` cannot be resolved.
 *
 * Never throws — callers decide what an out-of-root result means (workspace
 * reads fall through to the next allowed root before erroring).
 */
export function resolveWithinRoot(path: string, root: string): string | null {
  let absRoot: string
  try {
    absRoot = realpathSync.native(resolve(root))
  } catch {
    return null
  }

  let relPath = path
  if (isAbsolute(path)) {
    const absInput = resolveThroughExistingPrefix(resolve(path))
    if (!isPathInsideRoot(absInput, absRoot)) return null
    const fromRoot = relative(absRoot, absInput)
    relPath = fromRoot === '' ? '.' : fromRoot
  }

  const absTarget = resolve(absRoot, relPath)
  if (!isPathInsideRoot(absTarget, absRoot)) return null

  const resolved = resolveThroughExistingPrefix(absTarget)
  if (!isPathInsideRoot(resolved, absRoot)) return null

  return resolved
}
