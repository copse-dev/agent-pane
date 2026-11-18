// `afterFileEdit` hook `glob` evaluation shared by the Cursor and Copse adapters.
//
// The glob comes from a hooks.json the repository or user wrote, and it is
// matched on the main process for every edit. micromatch compiles it through
// picomatch to a RegExp, and some shapes (`+(*a)`, GHSA-fc5q-39xc-vjpf, or a raw
// `(a|*a)+`) compile to nested quantifiers that backtrack exponentially. So the
// match runs under the same wall-clock bound as the hook `matcher` regex
// (`matcher-regex.ts`).
import { relative } from 'node:path'
import micromatch from 'micromatch'
import { matchingIndexesWithin } from '@copse/std/bounded-regex.ts'

/** Budget for matching one edit's candidate paths. Real globs take microseconds. */
export const AFTER_FILE_EDIT_GLOB_TIMEOUT_MS = 50

/** Glob lists that have already run past the budget once (keyed by JSON). */
const pathologicalGlobs = new Set<string>()

/**
 * Whether an `afterFileEdit` hook's globs cover the edited path. No globs means
 * every edit (Cursor's default). Otherwise the absolute path is matched, plus,
 * when it is under the workspace, its workspace-relative form (so `**` and
 * `src/**` globs match the natural way), with a basename pass so a bare `*.ts`
 * still matches a nested file.
 *
 * A glob list that runs past {@link AFTER_FILE_EDIT_GLOB_TIMEOUT_MS} counts as
 * a match, now and on every later edit, without re-running: as with a
 * pathological `matcher`, firing the hook lets it decide, while skipping it
 * would silently drop a gate.
 */
export function afterFileEditGlobMatches(
  globs: readonly string[] | undefined,
  filePath: string,
  workspaceRoot: string | null,
): boolean {
  if (!globs || globs.length === 0) return true
  const key = JSON.stringify(globs)
  if (pathologicalGlobs.has(key)) return true
  const candidates = [filePath.replace(/\\/g, '/')]
  if (workspaceRoot) {
    const rel = relative(workspaceRoot, filePath).replace(/\\/g, '/')
    if (rel && !rel.startsWith('..')) candidates.push(rel)
  }
  const exact = globs.map((glob) => micromatch.matcher(glob, { dot: true }))
  const byBasename = globs.map((glob) => micromatch.matcher(glob, { dot: true, basename: true }))
  const tester = {
    test: (candidate: string): boolean =>
      exact.some((isMatch) => isMatch(candidate)) ||
      byBasename.some((isMatch) => isMatch(candidate)),
  }
  const hits = matchingIndexesWithin(tester, candidates, {
    timeoutMs: AFTER_FILE_EDIT_GLOB_TIMEOUT_MS,
    limit: 1,
  })
  if (hits !== 'timeout') return hits.length > 0
  pathologicalGlobs.add(key)
  console.warn(
    `[hooks] afterFileEdit glob ${key} ran past ${String(AFTER_FILE_EDIT_GLOB_TIMEOUT_MS)}ms — treated as a match from now on`,
  )
  return true
}
