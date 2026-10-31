import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPLORE_EXCERPTS_HEADING,
  mergeExploredSpans,
  renderExploreResult,
  selectExploreExcerpts,
  type ExploredSpan,
} from './explore-excerpts.ts'

function span(path: string, startLine: number, lines: readonly string[]): ExploredSpan {
  return { path, startLine, endLine: startLine + lines.length - 1, text: lines.join('\n') }
}

function numbered(prefix: string, from: number, to: number): string[] {
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`${prefix}${String(i)}`)
  return out
}

describe('mergeExploredSpans', () => {
  it('unions overlapping and adjacent reads of a path, keeping disjoint ones apart', () => {
    const merged = mergeExploredSpans([
      span('a.ts', 10, numbered('a', 10, 20)),
      span('b.ts', 1, numbered('b', 1, 3)),
      span('a.ts', 15, numbered('a', 15, 25)),
      span('a.ts', 26, numbered('a', 26, 27)),
      span('a.ts', 40, numbered('a', 40, 41)),
      span('a.ts', 12, numbered('a', 12, 13)),
    ])
    assert.deepEqual(merged, [
      span('a.ts', 10, numbered('a', 10, 27)),
      span('a.ts', 40, numbered('a', 40, 41)),
      span('b.ts', 1, numbered('b', 1, 3)),
    ])
  })

  it('drops empty reads (a start line past the end of the file)', () => {
    assert.deepEqual(mergeExploredSpans([{ path: 'a.ts', startLine: 9, endLine: 8, text: '' }]), [])
  })
})

describe('selectExploreExcerpts', () => {
  const big = span('big.ts', 1, numbered('x'.repeat(50), 1, 40))
  const cited = span('src/cited.ts', 5, numbered('c', 5, 9))
  const small = span('small.ts', 1, ['one', 'two'])

  it('keeps every span when the budget allows, in read order', () => {
    const selection = selectExploreExcerpts([small, big], 'nothing cited', 100_000)
    assert.deepEqual(selection, { kept: [small, big], dropped: [] })
  })

  it('drops a span over the budget whole and still fits later, smaller spans', () => {
    const selection = selectExploreExcerpts([big, small], '', small.text.length + 10)
    assert.deepEqual(selection.kept, [small])
    assert.deepEqual(selection.dropped, [big])
  })

  it('prefers spans whose file the summary names when the budget binds', () => {
    const budget = cited.text.length
    const selection = selectExploreExcerpts([small, cited], 'The handler is in cited.ts.', budget)
    assert.deepEqual(selection.kept, [cited])
    assert.deepEqual(selection.dropped, [small])
  })
})

describe('renderExploreResult', () => {
  it('returns the summary unchanged when nothing was read', () => {
    assert.equal(renderExploreResult('Summary.', { kept: [], dropped: [] }), 'Summary.')
  })

  it('fences each span with its exact text and names dropped spans with their ranges', () => {
    const kept = span('a.ts', 3, ['  if (x) {', '\treturn ```y```', '  }'])
    const dropped = span('b.ts', 1, ['only'])
    const text = renderExploreResult('Summary.', { kept: [kept], dropped: [dropped] })
    assert.ok(text.startsWith('Summary.\n'))
    assert.ok(text.includes(EXPLORE_EXCERPTS_HEADING))
    // The fence outgrows the longest backtick run so embedded fences survive.
    assert.ok(text.includes(`\`a.ts\` lines 3–5:\n\`\`\`\`\n${kept.text}\n\`\`\`\`\n`))
    assert.match(text, /Not quoted \(over the excerpt budget[^)]*\): `b\.ts` line 1\./)
  })
})
