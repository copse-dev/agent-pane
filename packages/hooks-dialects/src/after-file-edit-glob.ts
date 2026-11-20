// `afterFileEdit` hook `glob` evaluation shared by the Cursor and Copse adapters.
//
// The glob comes from a hooks.json the repository or user wrote, and it is
// matched on the main process for every edit. picomatch compiles it to a
// RegExp, and some shapes (`+(*a)`, GHSA-fc5q-39xc-vjpf, or a raw
// `(a|*a)+`) compile to nested quantifiers that backtrack exponentially. So the
// match runs under the same wall-clock bound as the hook `matcher` regex
// (`matcher-regex.ts`).
import picomatch from 'picomatch'
import { matchingIndexesWithin } from '@copse/std/bounded-regex.ts'
import { relativeWithin } from '@copse/std/path-containment.ts'
import { sha256Hex } from '@copse/std/sha256.ts'

/** Budget for matching one edit's candidate paths. Real globs take microseconds. */
export const AFTER_FILE_EDIT_GLOB_TIMEOUT_MS = 50

/** How many timed-out glob lists to remember; the oldest is forgotten first. */
const MAX_REMEMBERED_GLOB_LISTS = 256

/** A set that keeps at most `max` keys, forgetting the oldest added first. */
export interface RecentKeySet {
  has(key: string): boolean
  add(key: string): void
}

export function createRecentKeySet(max: number): RecentKeySet {
  const keys = new Set<string>()
  return {
    has: (key) => keys.has(key),
    add(key): void {
      keys.add(key)
      if (keys.size <= max) return
      const oldest = keys.values().next()
      if (!oldest.done) keys.delete(oldest.value)
    },
  }
}

/**
 * Glob lists that have already run past the budget, keyed by a hash of their
 * JSON so a huge list costs no more to remember than a short one. Capped: each
 * workspace's hooks.json can add lists, and a forgotten one only costs one more
 * budget the next time it runs.
 */
const pathologicalGlobs = createRecentKeySet(MAX_REMEMBERED_GLOB_LISTS)

/**
 * Whether an `afterFileEdit` hook's globs cover the edited path. No globs means
 * every edit (Cursor's default). Otherwise the absolute path is matched, plus,
 * when it is under the workspace, its workspace-relative form (so `**` and
 * `src/**` globs match the natural way), with a basename pass so a bare `*.ts`
 * still matches a nested file.
 *
 * A glob list that runs past {@link AFTER_FILE_EDIT_GLOB_TIMEOUT_MS} counts as
 * a match, now and on later edits, without re-running while it is remembered
 * (the most recent 256 lists): as with a pathological `matcher`,
 * firing the hook lets it decide, while skipping it would silently drop a gate.
 */
export function afterFileEditGlobMatches(
  globs: readonly string[] | undefined,
  filePath: string,
  workspaceRoot: string | null,
): boolean {
  if (!globs || globs.length === 0) return true
  const key = sha256Hex(JSON.stringify(globs))
  if (pathologicalGlobs.has(key)) return true
  const candidates = [filePath.replace(/\\/g, '/')]
  if (workspaceRoot) {
    const rel = relativeWithin(workspaceRoot, filePath)
    if (rel) candidates.push(rel.replace(/\\/g, '/'))
  }
  const exact = globs.map((glob) => picomatch(glob, { dot: true }))
  const byBasename = globs.map((glob) => picomatch(glob, { dot: true, basename: true }))
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
    `[hooks] afterFileEdit glob ${JSON.stringify(globs).slice(0, 200)} ran past ${String(AFTER_FILE_EDIT_GLOB_TIMEOUT_MS)}ms — treated as a match from now on`,
  )
  return true
}
