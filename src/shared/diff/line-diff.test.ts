import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { computeLineDiff, foldLineDiff, type LineDiffLine } from './line-diff.ts'
import { computeLineDiffStats } from './line-stats.ts'

const render = (lines: readonly LineDiffLine[]): string[] =>
  lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)

describe('computeLineDiff', () => {
  it('marks every line of a new file as added', () => {
    assert.deepEqual(render(computeLineDiff('', 'a\nb\n')), ['+a', '+b'])
  })

  it('keeps shared lines as context and groups a replacement deletions-first', () => {
    assert.deepEqual(render(computeLineDiff('a\nold1\nold2\nz\n', 'a\nnew\nz\n')), [
      ' a',
      '-old1',
      '-old2',
      '+new',
      ' z',
    ])
  })

  it('finds an insertion between retained lines inside a changed middle', () => {
    assert.deepEqual(render(computeLineDiff('a\nb\nc\nd\n', 'x\nb\ny\nc\nd\n')), [
      '-a',
      '+x',
      ' b',
      '+y',
      ' c',
      ' d',
    ])
  })

  it('shows a final-newline-only edit and identifies the unterminated side', () => {
    const added = computeLineDiff('a\nb', 'a\nb\n')
    assert.deepEqual(render(added), [' a', '-b', '+b'])
    assert.equal(added[1]?.noNewlineAtEnd, true)
    assert.equal(added[2]?.noNewlineAtEnd, undefined)

    const removed = computeLineDiff('a\nb\n', 'a\nb')
    assert.deepEqual(render(removed), [' a', '-b', '+b'])
    assert.equal(removed[1]?.noNewlineAtEnd, undefined)
    assert.equal(removed[2]?.noNewlineAtEnd, true)
  })

  it('does not show a CRLF-to-LF conversion as identical-looking changes', () => {
    assert.deepEqual(render(computeLineDiff('a\r\nb\r\n', 'a\nb\n')), [' a', ' b'])
  })

  it('reconstructs both sides and matches the minimal line counts', () => {
    const text = fc
      .array(fc.constantFrom('a', 'b', 'c', 'd', ''), { maxLength: 12 })
      .map((lines) => lines.map((line) => `${line}\n`).join(''))
    fc.assert(
      fc.property(text, text, (before, after) => {
        const lines = computeLineDiff(before, after)
        const side = (skip: LineDiffLine['kind']): string =>
          lines
            .filter((line) => line.kind !== skip)
            .map((line) => `${line.text}${line.noNewlineAtEnd ? '' : '\n'}`)
            .join('')
        assert.equal(side('add'), before)
        assert.equal(side('del'), after)
        assert.deepEqual(
          {
            additions: lines.filter((line) => line.kind === 'add').length,
            deletions: lines.filter((line) => line.kind === 'del').length,
          },
          computeLineDiffStats(before, after),
        )
      }),
    )
  })

  it('falls back to a block replacement when the changed middle is too large', () => {
    const before = Array.from({ length: 1500 }, (_, i) => `old ${String(i)}`).join('\n')
    const after = Array.from({ length: 1500 }, (_, i) => `new ${String(i)}`).join('\n')
    const lines = computeLineDiff(`keep\n${before}\n`, `keep\n${after}\n`)
    assert.equal(lines[0]?.kind, 'context')
    assert.equal(lines.filter((line) => line.kind === 'del').length, 1500)
    assert.equal(lines.filter((line) => line.kind === 'add').length, 1500)
    assert.equal(lines[1]?.kind, 'del')
    assert.equal(lines.at(-1)?.kind, 'add')
  })
})

describe('foldLineDiff', () => {
  it('folds unchanged runs beyond the context window into gaps', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\n'
    const after = 'a\nb\nc\nd\nE\nf\ng\nh\ni\n'
    assert.deepEqual(foldLineDiff(computeLineDiff(before, after), 1), [
      { kind: 'gap', count: 3 },
      { kind: 'context', text: 'd' },
      { kind: 'del', text: 'e' },
      { kind: 'add', text: 'E' },
      { kind: 'context', text: 'f' },
      { kind: 'gap', count: 3 },
    ])
  })

  it('shows a single hidden line instead of a one-line gap', () => {
    const folded = foldLineDiff(computeLineDiff('a\nb\nc\n', 'a\nb\nC\n'), 1)
    assert.deepEqual(folded, [
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'del', text: 'c' },
      { kind: 'add', text: 'C' },
    ])
  })
})
