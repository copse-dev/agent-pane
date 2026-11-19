import { isAbsolute, relative, sep } from 'node:path'

/**
 * `target`'s path relative to `root` when `target` is `root` itself (`''`) or
 * lies beneath it, and `null` when it escapes: `..`, a `../`-prefixed path, or an
 * absolute result (Windows paths on different drives). A name that merely starts
 * with two dots, such as `..cache`, is inside.
 *
 * Purely lexical, like `path.relative`: both sides are resolved against the
 * working directory but symlinks are not followed, so a caller guarding a
 * filesystem boundary compares `realpath`ed paths.
 */
export function relativeWithin(root: string, target: string): string | null {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

/**
 * Whether `target` lies inside `root`. `root` itself counts unless
 * `allowSelf` is false, which asks for a strict descendant. Lexical; see
 * {@link relativeWithin}.
 */
export function isPathWithin(
  root: string,
  target: string,
  { allowSelf = true }: { allowSelf?: boolean } = {},
): boolean {
  const rel = relativeWithin(root, target)
  return rel !== null && (allowSelf || rel !== '')
}
