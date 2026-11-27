import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, sep } from 'node:path'

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function within(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep))
}

/**
 * Resolve a bare program name on `pathValue` the way a shell would, and return its
 * path only when neither it nor any PATH entry searched before it lies inside one
 * of `writableRoots`. Null otherwise: a writable directory on the search path can
 * hold a stand-in for the program, and a stand-in is exactly what must not run
 * with the egress a network scope opens for the real one.
 *
 * Relative PATH entries are refused outright, since they resolve against the
 * command's working directory.
 */
export function resolveProgramOutsideRoots(
  program: string,
  pathValue: string,
  writableRoots: readonly string[],
): string | null {
  if (program.includes('/')) return null
  const roots = [...new Set(writableRoots.flatMap((root) => [root, canonical(root)]))]
  for (const entry of pathValue.split(delimiter)) {
    if (entry === '' || !isAbsolute(entry)) return null
    if (within(entry, roots) || within(canonical(entry), roots)) return null
    const candidate = join(entry, program)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    const real = canonical(candidate)
    return within(real, roots) ? null : real
  }
  return null
}
