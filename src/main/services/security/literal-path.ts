import { sep } from 'node:path'

/**
 * A path segment the shell reads literally: letters, digits and marks in any
 * script, plus punctuation no supported shell expands on its own. It is an
 * allow-list so it fails closed; anything else — braces, globs (`* ? [`), `$`,
 * backticks, quotes, backslashes, `~`, extglob parentheses, zsh `^`/`#` —
 * counts as expansion. Paired percent signs are rejected separately because
 * cmd.exe expands `%NAME%` even though a lone `%` is an ordinary filename mark.
 */
const LITERAL_SEGMENT = /^[\p{L}\p{M}\p{N} ._\-+@,:%=]*$/u

/**
 * True when every segment of `target` names itself. Targets are the tokens the
 * agent wrote, and the shell expands them only after the gate has decided, so a
 * token like `dir/{..,sub}/x` sits under `dir` as text but reads `dir/../x`.
 * `target` is already `resolve()`d, so it uses only the platform separator: on
 * POSIX a backslash escape (`\.\.`) stays inside its segment and is refused.
 */
export function isLiteralPath(target: string): boolean {
  return target
    .split(sep)
    .every((segment) => LITERAL_SEGMENT.test(segment) && !/%[^%]*%/.test(segment))
}
