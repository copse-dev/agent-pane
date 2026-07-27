/**
 * Test-file filtering for `npm test -- <filter…>`.
 *
 * The unit tier is the cheapest place to get signal, but `npm test` bundles and
 * runs *every* `*.test.ts` in the repo — so "check the one thing I just
 * changed" costs the same as a full run, and agents skip it. These helpers let
 * the runner take positional filters and bundle only the matching files.
 *
 * Matching is deliberately forgiving, because the whole point is that a filter
 * should be guessable without looking up the exact path:
 *   • a glob (`src/main/**`, `*-store.test.ts`) is matched with micromatch
 *   • anything else matches as a case-insensitive substring of the repo-relative
 *     path, or as the file's base name with or without the `.test.ts` suffix
 * Multiple filters union (they select the files matching *any* of them).
 *
 * Forgiving matching makes a typo look like "0 tests, all green", so a filter
 * that selects nothing is an error the caller must surface — never an empty
 * pass. {@link describeNoMatch} builds the message for that case.
 */
import micromatch from 'micromatch'

const GLOB_CHARS = /[*?[\]{}!]/

/** Repo-relative, forward-slashed — the form filters are matched against. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** `src/a/b-store.test.ts` → `b-store` (the name a filter most likely means). */
function stem(path: string): string {
  const base = normalize(path).split('/').pop() ?? ''
  return base.replace(/\.test\.ts$/, '')
}

/** Whether one filter selects one test file. */
export function matchesFilter(testFile: string, filter: string): boolean {
  const path = normalize(testFile)
  const raw = normalize(filter)
  if (!raw) return false
  if (GLOB_CHARS.test(raw)) return micromatch.isMatch(path, raw, { nocase: true, dot: true })
  const needle = raw.toLowerCase()
  if (path.toLowerCase().includes(needle)) return true
  // Bare names: `thread-store` and `thread-store.test.ts` both select the file.
  const base = stem(path).toLowerCase()
  return base === needle || base === needle.replace(/\.test\.ts$/, '')
}

/**
 * The test files `filters` select, in the order `all` was given. No filters
 * means the whole suite — a bare `npm test` must keep running everything.
 */
export function selectTestFiles(all: string[], filters: string[]): string[] {
  if (filters.length === 0) return [...all]
  return all.filter((f) => filters.some((filter) => matchesFilter(f, filter)))
}

/** Filters that matched nothing — reported individually so a typo is obvious. */
export function unmatchedFilters(all: string[], filters: string[]): string[] {
  return filters.filter((filter) => !all.some((f) => matchesFilter(f, filter)))
}

/**
 * Words present in (nearly) every test path. Suggesting on one of these returns
 * the first N files alphabetically, which reads as a confident answer while
 * carrying no information — worse than saying nothing.
 */
const SUGGEST_STOPLIST = new Set(['test', 'tests', 'src', 'spec', 'ts', 'js', 'packages'])

/**
 * Test files sharing a word with `filter`, as "did you mean" candidates. A
 * filter usually fails because the name is close but not exact (`thread_store`,
 * `threadstore`), so splitting on separators and matching any token recovers
 * most typos without a fuzzy-distance implementation.
 */
export function suggestTestFiles(all: string[], filter: string, limit = 5): string[] {
  const tokens = normalize(filter)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !SUGGEST_STOPLIST.has(t))
  if (tokens.length === 0) return []
  return all
    .filter((f) => tokens.some((t) => normalize(f).toLowerCase().includes(t)))
    .slice(0, limit)
}

/**
 * The error text for a filter set that selected nothing. Returns null when
 * everything matched, so callers can use it as the whole no-match check.
 */
export function describeNoMatch(all: string[], filters: string[]): string | null {
  const missed = unmatchedFilters(all, filters)
  if (missed.length === 0) return null
  const lines = [
    `[run-tests] no test files match: ${missed.join(', ')}`,
    `[run-tests] ${String(all.length)} test file(s) available.`,
  ]
  for (const filter of missed) {
    const suggestions = suggestTestFiles(all, filter)
    if (suggestions.length > 0) {
      lines.push(`  did you mean (for "${filter}")?`)
      for (const s of suggestions) lines.push(`    ${s}`)
    }
  }
  lines.push(`[run-tests] filters match a path substring, a base name, or a glob.`)
  return lines.join('\n')
}

/** Where esbuild writes a test file's bundle, given `outbase: '.'`. */
export function testOutputPath(testFile: string): string {
  return `dist-test/${normalize(testFile).replace(/\.ts$/, '.js')}`
}
