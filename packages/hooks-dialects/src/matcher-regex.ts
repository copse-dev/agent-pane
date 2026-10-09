// Hook `matcher` regex evaluation shared by the Cursor and Claude adapters.
//
// A matcher is evaluated on the main process for every candidate event, so it
// is compiled once per distinct pattern and run under a wall-clock bound: a
// catastrophically backtracking pattern (`(a+)+$`) against a long shell command
// would otherwise freeze the app on every gated call.
import { regexTestWithin } from '@copse/std/bounded-regex.ts'

/** Budget for one matcher test. Real matchers finish in microseconds. */
export const HOOK_MATCHER_TIMEOUT_MS = 50

/** Distinct patterns kept compiled; cleared wholesale past this (configs are small). */
const MAX_CACHED_MATCHERS = 256

/** Compiled matchers by pattern; null records a pattern that does not compile. */
const compiledMatchers = new Map<string, RegExp | null>()

/** Patterns that have already run past {@link HOOK_MATCHER_TIMEOUT_MS} once. */
const pathologicalMatchers = new Set<string>()

/**
 * Test a hook matcher pattern against `subject`.
 *
 * - `'invalid'`: the pattern does not compile (the caller decides; both
 *   adapters skip the hook).
 * - `'timeout'`: the pattern backtracked past its budget, now or on an earlier
 *   call. It is not re-run, so a pathological matcher costs one budget per
 *   process, not one per event. Callers treat this as a match: firing the hook
 *   lets it decide, while skipping it would silently drop a gate.
 */
export function testHookMatcher(pattern: string, subject: string): boolean | 'invalid' | 'timeout' {
  if (pathologicalMatchers.has(pattern)) return 'timeout'
  const regex = compileMatcher(pattern)
  if (regex === null) return 'invalid'
  const result = regexTestWithin(regex, subject, HOOK_MATCHER_TIMEOUT_MS)
  if (result === 'timeout') {
    pathologicalMatchers.add(pattern)
    console.warn(
      `[hooks] matcher /${pattern}/ ran past ${String(HOOK_MATCHER_TIMEOUT_MS)}ms — treated as a match from now on`,
    )
  }
  return result
}

function compileMatcher(pattern: string): RegExp | null {
  const cached = compiledMatchers.get(pattern)
  if (cached !== undefined) return cached
  let regex: RegExp | null
  try {
    regex = new RegExp(pattern)
  } catch {
    regex = null
  }
  if (compiledMatchers.size >= MAX_CACHED_MATCHERS) compiledMatchers.clear()
  compiledMatchers.set(pattern, regex)
  return regex
}
