/** Line add/delete counts for a before/after text pair (git diff --numstat style). */
export interface LineDiffStats {
  additions: number
  deletions: number
}

/**
 * Ceiling on the diff search, counted in `(n + m) x d` steps. The search runs on
 * the main process inside `write_file` / `str_replace`, so it must not block the
 * app for seconds on a pathological rewrite. ~1e8 steps is roughly a quarter of a
 * second; beyond it {@link computeLineDiffStats} reports a proven lower bound
 * instead of the exact minimal edit script.
 */
const MAX_DIFF_STEPS = 100_000_000

/** Split file text into logical lines (git treats '' as zero lines, not one empty line). */
function splitIntoLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** Replace each distinct line with an integer id so the diff loops compare numbers, not strings. */
function internLines(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>()
  const encode = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
      }
      out[i] = id
    }
    return out
  }
  return [encode(a), encode(b)]
}

/**
 * Length of the shortest edit script between `a` and `b` — Myers' greedy
 * algorithm, keeping only the furthest-reaching endpoint per diagonal because the
 * caller wants the distance, not the script. That needs O(n + m) memory instead
 * of the O(n * m) table an LCS DP allocates, and it finishes in O((n + m) * d),
 * so a small edit to a large file costs almost nothing.
 *
 * Returns `null` when the search would pass `maxDistance` without converging.
 */
function shortestEditDistance(a: Int32Array, b: Int32Array, maxDistance: number): number | null {
  const n = a.length
  const m = b.length
  // Diagonal k is x - y, so k ranges over [-n, m]; `offset` centres it in the array.
  const offset = n + m
  const endpoints = new Int32Array(2 * offset + 1)
  const limit = Math.min(maxDistance, offset)
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      // Extend whichever neighbouring diagonal reaches further: down from k + 1
      // (a deletion) or right from k - 1 (an insertion).
      const below = endpoints[offset + k + 1] ?? 0
      let x =
        k === -d || (k !== d && (endpoints[offset + k - 1] ?? 0) < below)
          ? below
          : (endpoints[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      endpoints[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return null
}

/** How many lines the two sides share ignoring order — an upper bound on the LCS length. */
function sharedLineCount(a: Int32Array, b: Int32Array): number {
  const remaining = new Map<number, number>()
  for (const id of a) remaining.set(id, (remaining.get(id) ?? 0) + 1)
  let shared = 0
  for (const id of b) {
    const left = remaining.get(id) ?? 0
    if (left > 0) {
      remaining.set(id, left - 1)
      shared += 1
    }
  }
  return shared
}

/**
 * Count lines added and removed between two file snapshots — matches git
 * `diff --numstat` semantics for whole-file replacements.
 *
 * Identical head and tail lines are dropped first (they are always part of some
 * minimal edit script), which reduces the usual case — a small edit inside a
 * large file — to a few lines of real work.
 *
 * On a pathological rewrite where the exact search exceeds {@link MAX_DIFF_STEPS},
 * the result is the best proven *lower* bound on the edit distance rather than an
 * unbounded search: the two sides cannot share more lines than they have in
 * common, and the truncated search itself proves the distance is larger than the
 * budget it exhausted.
 */
export function computeLineDiffStats(before: string, after: string): LineDiffStats {
  const beforeLines = splitIntoLines(before)
  const afterLines = splitIntoLines(after)

  let start = 0
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1
  }
  let beforeEnd = beforeLines.length
  let afterEnd = afterLines.length
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  const n = beforeEnd - start
  const m = afterEnd - start
  if (n === 0) return { additions: m, deletions: 0 }
  if (m === 0) return { additions: 0, deletions: n }

  const [a, b] = internLines(beforeLines.slice(start, beforeEnd), afterLines.slice(start, afterEnd))
  const maxDistance = Math.max(1, Math.floor(MAX_DIFF_STEPS / (n + m)))
  let distance = shortestEditDistance(a, b, maxDistance)
  if (distance === null) {
    // Both terms below are proven lower bounds on the true distance; take the tighter.
    distance = Math.max(maxDistance + 1, n + m - 2 * sharedLineCount(a, b))
    // An edit script's length always has the parity of (m - n); round the bound up to it.
    if ((distance - (m - n)) % 2 !== 0) distance += 1
  }
  return { additions: (distance + m - n) / 2, deletions: (distance - m + n) / 2 }
}
