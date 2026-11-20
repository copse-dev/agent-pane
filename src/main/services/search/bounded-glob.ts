// Glob matching for patterns Copse did not write: model tool arguments, a
// repository's `.gitignore`, `.cursor/rules/*.mdc` globs.
//
// picomatch compiles a glob to a JavaScript RegExp, and some glob shapes
// compile to nested unbounded quantifiers that backtrack exponentially on a
// short non-matching path. GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7, no patched
// release) covers single-branch repeated extglobs such as `+(*a)`, which
// becomes `(?:[^/]*?a)+`. Raw groups followed by a quantifier, such as `(*a)+`
// or `(a|*a)+`, compile to the same shape, and `noextglob` does not prevent
// that. So rather than guessing which patterns are dangerous, every match runs
// under the same wall-clock bound the hook matchers use
// (`@copse/std/bounded-regex.ts`), which V8 interrupts when the budget is
// spent.
import picomatch from 'picomatch'
import { matchingIndexesWithin } from '@copse/std/bounded-regex.ts'

/** Budget for matching one subject. Real globs match a path in microseconds. */
export const GLOB_SUBJECT_TIMEOUT_MS = 50

/** Budget for filtering a whole file index in one call. */
export const GLOB_LIST_TIMEOUT_MS = 1_000

/** Budget for one {@link boundedGlobMatcher} call (one directory's entries, say). */
const GLOB_BATCH_TIMEOUT_MS = 250

/**
 * Budget for every call one {@link boundedGlobMatcher} makes, taken together.
 * Each call starts a watchdog (about 75 µs), and a walk makes one call per
 * directory, so this leaves room for very large trees while stopping a glob
 * that stays just under the per-call budget on every directory.
 */
const GLOB_TOTAL_TIMEOUT_MS = 5_000

/** Shown to the model when its glob blows the budget. */
export const GLOB_TIMEOUT_HINT =
  'Glob pattern took too long to match and was abandoned. Repeated groups that contain `*`, such as `+(*a)` or `(a|*a)+`, backtrack exponentially; use a simpler glob or braces, e.g. "{*a*,*b*}".'

/**
 * One result per subject (`true` for a match), or `'timeout'` when the budget
 * ran out first.
 */
export type BoundedGlobMatcher = (subjects: readonly string[]) => boolean[] | 'timeout'

function compile(
  patterns: string | readonly string[],
  options: picomatch.PicomatchOptions,
): (subject: string) => boolean {
  const list = typeof patterns === 'string' ? [patterns] : patterns
  const matchers = list.map((pattern) => picomatch(pattern, options))
  return (subject) => matchers.some((isMatch) => isMatch(subject))
}

/**
 * Time left for a group of glob calls that together must not run longer than
 * one budget, such as every directory of a walk or every rule of a turn. Each
 * call already has its own timeout; without a shared budget, a glob that stays
 * just under it could repeat that cost on every call.
 */
export interface GlobBudget {
  remainingMs: number
}

export function createGlobBudget(totalMs: number): GlobBudget {
  return { remainingMs: totalMs }
}

/** One bounded call, charged to `budget` when given. */
function matchWithin(
  tester: { test(subject: string): boolean },
  subjects: readonly string[],
  opts: { timeoutMs: number; limit?: number; budget?: GlobBudget },
): number[] | 'timeout' {
  const { budget } = opts
  if (budget && budget.remainingMs <= 0) return 'timeout'
  const timeoutMs = budget ? Math.min(opts.timeoutMs, budget.remainingMs) : opts.timeoutMs
  const started = performance.now()
  const hits = matchingIndexesWithin(tester, subjects, {
    timeoutMs,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })
  // A call that timed out spent its whole allowance. Charging only the measured
  // time can leave a sliver of budget, because V8's watchdog runs on libuv's
  // millisecond timer and may fire slightly before `performance.now()` agrees.
  const elapsed = performance.now() - started
  if (budget) budget.remainingMs -= hits === 'timeout' ? Math.max(elapsed, timeoutMs) : elapsed
  return hits
}

/**
 * Compile `patterns` once (any one matching counts, like `picomatch.isMatch`
 * with an array) and match a batch of subjects per call. Each call gets at most
 * `callTimeoutMs`, and all calls together get at most `totalTimeoutMs`: once
 * that is spent every later call reports `'timeout'` without matching, so a
 * glob that runs just under the per-call budget cannot repeat that cost for
 * every batch of a long walk.
 */
export function boundedGlobMatcher(
  patterns: string | readonly string[],
  options: picomatch.PicomatchOptions = {},
  budget: { callTimeoutMs?: number; totalTimeoutMs?: number } = {},
): BoundedGlobMatcher {
  const tester = { test: compile(patterns, options) }
  const timeoutMs = budget.callTimeoutMs ?? GLOB_BATCH_TIMEOUT_MS
  const total = createGlobBudget(budget.totalTimeoutMs ?? GLOB_TOTAL_TIMEOUT_MS)
  return (subjects) => {
    if (subjects.length === 0) return []
    const hits = matchWithin(tester, subjects, { timeoutMs, budget: total })
    if (hits === 'timeout') return 'timeout'
    const matched = subjects.map(() => false)
    for (const index of hits) matched[index] = true
    return matched
  }
}

/**
 * `subjects.filter` by a single pattern (or any of several), keeping the subjects' order and stopping after `limit` matches,
 * under one budget for the whole list. Pass `budget` to also charge the call
 * to a budget shared with other calls; once it is spent this reports
 * `'timeout'` without matching.
 */
export function globFilterWithin(
  subjects: readonly string[],
  pattern: string | readonly string[],
  options: picomatch.PicomatchOptions,
  opts: { timeoutMs?: number; limit?: number; budget?: GlobBudget } = {},
): string[] | 'timeout' {
  const tester = { test: compile(pattern, options) }
  const hits = matchWithin(tester, subjects, {
    timeoutMs: opts.timeoutMs ?? GLOB_LIST_TIMEOUT_MS,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  })
  if (hits === 'timeout') return 'timeout'
  return hits.flatMap((index) => {
    const subject = subjects[index]
    return subject === undefined ? [] : [subject]
  })
}
