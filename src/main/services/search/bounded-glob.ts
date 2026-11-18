// Glob matching for patterns Copse did not write: model tool arguments, a
// repository's `.gitignore`, `.cursor/rules/*.mdc` globs.
//
// micromatch compiles a glob to a JavaScript RegExp through picomatch, and some
// glob shapes compile to nested unbounded quantifiers that backtrack
// exponentially on a short non-matching path. GHSA-fc5q-39xc-vjpf (picomatch
// <=4.0.7, no patched release) covers single-branch repeated extglobs such as
// `+(*a)`, which becomes `(?:[^/]*?a)+`. Raw groups followed by a quantifier,
// such as `(*a)+` or `(a|*a)+`, compile to the same shape, and `noextglob` does
// not prevent that. So rather than guessing which patterns are dangerous, every
// match runs under the same wall-clock bound the hook matchers use
// (`@copse/std/bounded-regex.ts`), which V8 interrupts when the budget is spent.
import micromatch from 'micromatch'
import { matchingIndexesWithin } from '@copse/std/bounded-regex.ts'

/** Budget for matching one subject. Real globs match a path in microseconds. */
export const GLOB_SUBJECT_TIMEOUT_MS = 50

/** Budget for filtering a whole file index in one call. */
export const GLOB_LIST_TIMEOUT_MS = 1_000

/** Shown to the model when its glob blows the budget. */
export const GLOB_TIMEOUT_HINT =
  'Glob pattern took too long to match and was abandoned. Repeated groups that contain `*`, such as `+(*a)` or `(a|*a)+`, backtrack exponentially; use a simpler glob or braces, e.g. "{*a*,*b*}".'

/** `true`/`false` for a match, or `'timeout'` when the budget ran out first. */
export type BoundedGlobMatcher = (subject: string) => boolean | 'timeout'

function compile(
  patterns: string | readonly string[],
  options: micromatch.Options,
): (subject: string) => boolean {
  const list = typeof patterns === 'string' ? [patterns] : patterns
  const matchers = list.map((pattern) => micromatch.matcher(pattern, options))
  return (subject) => matchers.some((isMatch) => isMatch(subject))
}

/**
 * Compile `patterns` once (any one matching counts, like `micromatch.isMatch`
 * with an array) and match one subject per call under `timeoutMs`. Each call
 * starts a watchdog (tens of microseconds), so prefer {@link globFilterWithin}
 * when the subjects are all known up front.
 */
export function boundedGlobMatcher(
  patterns: string | readonly string[],
  options: micromatch.Options = {},
  timeoutMs = GLOB_SUBJECT_TIMEOUT_MS,
): BoundedGlobMatcher {
  const tester = { test: compile(patterns, options) }
  return (subject) => {
    const hits = matchingIndexesWithin(tester, [subject], { timeoutMs, limit: 1 })
    return hits === 'timeout' ? 'timeout' : hits.length > 0
  }
}

/**
 * `micromatch(subjects, pattern, options)` for a single pattern (or any of
 * several), keeping the subjects' order and stopping after `limit` matches,
 * under one budget for the whole list.
 */
export function globFilterWithin(
  subjects: readonly string[],
  pattern: string | readonly string[],
  options: micromatch.Options,
  opts: { timeoutMs?: number; limit?: number } = {},
): string[] | 'timeout' {
  const tester = { test: compile(pattern, options) }
  const hits = matchingIndexesWithin(tester, subjects, {
    timeoutMs: opts.timeoutMs ?? GLOB_LIST_TIMEOUT_MS,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })
  if (hits === 'timeout') return 'timeout'
  return hits.flatMap((index) => {
    const subject = subjects[index]
    return subject === undefined ? [] : [subject]
  })
}
