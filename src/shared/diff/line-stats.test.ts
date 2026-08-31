import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeLineDiffStats, type LineDiffStats } from './line-stats.ts'

describe('computeLineDiffStats', () => {
  it('counts new file lines as additions', () => {
    assert.deepEqual(computeLineDiffStats('', 'a\nb\n'), { additions: 2, deletions: 0 })
  })

  it('counts removed lines as deletions', () => {
    assert.deepEqual(computeLineDiffStats('a\nb\n', ''), { additions: 0, deletions: 2 })
  })

  it('counts replaced lines as add + delete', () => {
    assert.deepEqual(computeLineDiffStats('old\n', 'new\n'), { additions: 1, deletions: 1 })
  })

  it('reports zero when content is unchanged', () => {
    assert.deepEqual(computeLineDiffStats('same\n', 'same\n'), { additions: 0, deletions: 0 })
  })

  it('matches git numstat for a single line without trailing newline', () => {
    assert.deepEqual(computeLineDiffStats('', 'a'), { additions: 1, deletions: 0 })
    assert.deepEqual(computeLineDiffStats('a', ''), { additions: 0, deletions: 1 })
  })

  it('counts an insertion in the middle without touching the surrounding lines', () => {
    assert.deepEqual(computeLineDiffStats('a\nb\nc\n', 'a\nx\nb\nc\n'), {
      additions: 1,
      deletions: 0,
    })
  })

  it('counts a reordering as the moved lines only', () => {
    assert.deepEqual(computeLineDiffStats('a\nb\nc\n', 'c\na\nb\n'), {
      additions: 1,
      deletions: 1,
    })
  })

  it('agrees with a reference LCS diff on random inputs', () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 0x2f6e2b1
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const randomLines = (count: number): string => {
      const alphabet = 'abcde'
      let out = ''
      for (let i = 0; i < count; i += 1) {
        out += `${alphabet[Math.floor(next() * alphabet.length)] ?? 'a'}\n`
      }
      return out
    }
    for (let trial = 0; trial < 400; trial += 1) {
      const before = randomLines(Math.floor(next() * 9))
      const after = randomLines(Math.floor(next() * 9))
      assert.deepEqual(
        computeLineDiffStats(before, after),
        referenceLineDiffStats(before, after),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      )
    }
  })

  it('stays fast and bounded when a large file gains one line', () => {
    const before = `${Array.from({ length: 40_000 }, (_, i) => `line ${String(i)}`).join('\n')}\n`
    const started = Date.now()
    assert.deepEqual(computeLineDiffStats(before, `${before}tail\n`), {
      additions: 1,
      deletions: 0,
    })
    // The old O(n*m) LCS table needed ~1.6e9 cells (many GB) for this shape.
    assert.ok(Date.now() - started < 2_000, 'one-line append to a large file must be cheap')
  })

  it('reports a lower bound rather than hanging on a pathological rewrite', () => {
    const before = `${Array.from({ length: 30_000 }, (_, i) => `line ${String(i)}`).join('\n')}\n`
    const after = `${before.trimEnd().split('\n').reverse().join('\n')}\n`
    const started = Date.now()
    const stats = computeLineDiffStats(before, after)
    assert.ok(Date.now() - started < 5_000, 'the search must respect its step budget')
    // Reversing every line really costs ~30k edits; the budgeted answer under-counts
    // but must still read as a substantial rewrite, never as "no change".
    assert.equal(stats.additions, stats.deletions)
    assert.ok(stats.additions > 0, 'a full reversal must not report zero edits')
    assert.ok(stats.additions <= 30_000)
  })
})

/**
 * Straightforward O(n*m) LCS table — the shape `computeLineDiffStats` used before
 * it needed to stay bounded. Kept here as the oracle the fast implementation is
 * checked against on small inputs.
 */
function referenceLineDiffStats(before: string, after: string): LineDiffStats {
  const split = (text: string): string[] => {
    if (text === '') return []
    const lines = text.split('\n')
    if (text.endsWith('\n')) lines.pop()
    return lines
  }
  const a = split(before)
  const b = split(after)
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i += 1) {
    const prevRow = dp[i - 1] ?? []
    const curRow = dp[i] ?? []
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) curRow[j] = (prevRow[j - 1] ?? 0) + 1
      else curRow[j] = Math.max(prevRow[j] ?? 0, curRow[j - 1] ?? 0)
    }
  }
  const lcs = dp[n]?.[m] ?? 0
  return { additions: m - lcs, deletions: n - lcs }
}
