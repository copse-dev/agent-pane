import { statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isGuardedYoloActive } from './guarded-yolo.ts'

/**
 * Session-only, thread-scoped read grants for named outside-project paths.
 * An approved file covers that file; an approved directory covers its children.
 * Grants die with the process and are never shared between threads.
 *
 * Every later command is independently checked as an accountable plain read.
 * Guarded YOLO retains its separate, broader outside-read authority while active.
 * The decision log records both the approval and each use of a grant.
 */
const grantedPaths = new Map<string, Map<string, boolean>>()

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // A missing or inaccessible path cannot safely grant its descendants.
    return false
  }
}

/**
 * A path segment the shell reads literally: letters, digits and marks in any
 * script, plus punctuation no shell expands. It is an allow-list so it fails
 * closed; anything else — braces, globs (`* ? [`), `$`, backticks, quotes,
 * backslashes, `~`, extglob parentheses, zsh `^`/`#` — counts as expansion.
 */
const LITERAL_SEGMENT = /^[\p{L}\p{M}\p{N} ._\-+@,:%=]*$/u

/**
 * True when every segment of `target` names itself. Targets are the tokens the
 * agent wrote, and the shell expands them only after the gate has decided, so a
 * token like `dir/{..,sub}/x` sits under `dir` as text but reads `dir/../x`.
 * `target` is already `resolve()`d, so it uses only the platform separator: on
 * POSIX a backslash escape (`\.\.`) stays inside its segment and is refused.
 */
function isLiteralPath(target: string): boolean {
  return target.split(sep).every((segment) => LITERAL_SEGMENT.test(segment))
}

function coversPath(granted: string, directory: boolean, target: string): boolean {
  // The same token re-reads exactly what the user approved, expansion and all.
  if (granted === target) return true
  if (!directory) return false
  // A descendant is covered only when the shell cannot turn it into another path.
  if (!isLiteralPath(target)) return false
  const child = relative(granted, target)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function grantReadOutsideProject(threadId: string, targets: readonly string[]): void {
  const paths = grantedPaths.get(threadId) ?? new Map<string, boolean>()
  for (const target of targets) {
    const path = resolve(target)
    paths.set(path, isDirectory(path))
  }
  grantedPaths.set(threadId, paths)
}

export function hasReadOutsideProjectGrant(
  threadId: string | null,
  targets: readonly string[],
): boolean {
  if (threadId === null || targets.length === 0) return false
  if (isGuardedYoloActive(threadId)) return true
  const paths = grantedPaths.get(threadId)
  if (!paths) return false
  return targets.every((target) => {
    const resolved = resolve(target)
    return [...paths].some(([granted, directory]) => coversPath(granted, directory, resolved))
  })
}

/** Drop every grant. For tests and teardown; not wired to any user action. */
export function clearReadOutsideProjectGrants(): void {
  grantedPaths.clear()
}
