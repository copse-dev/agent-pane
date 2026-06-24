/** Line add/delete counts for a before/after text pair (git diff --numstat style). */
export interface LineDiffStats {
  additions: number
  deletions: number
}

/** Split file text into logical lines (git treats '' as zero lines, not one empty line). */
function splitIntoLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Count lines added and removed between two file snapshots using an LCS line
 * diff — matches git `diff --numstat` semantics for whole-file replacements.
 */
export function computeLineDiffStats(before: string, after: string): LineDiffStats {
  const a = splitIntoLines(before)
  const b = splitIntoLines(after)
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const prevRow = dp[i - 1]!
      const curRow = dp[i]!
      if (a[i - 1] === b[j - 1]) curRow[j] = prevRow[j - 1]! + 1
      else curRow[j] = Math.max(prevRow[j]!, curRow[j - 1]!)
    }
  }
  const lcs = dp[n]![m]!
  return { additions: m - lcs, deletions: n - lcs }
}
