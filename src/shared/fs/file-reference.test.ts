import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileReferenceMatches } from './file-reference.ts'

describe('fileReferenceMatches', () => {
  it('matches nested paths and bare filenames', () => {
    const matches = fileReferenceMatches('Read src/main/index.ts and renderer.ts please')
    assert.deepEqual(
      matches.map((m) => m.candidate),
      ['src/main/index.ts', 'renderer.ts'],
    )
    assert.equal(
      matches.every((m) => m.line === undefined && m.column === undefined),
      true,
    )
  })

  it('captures a :line suffix', () => {
    const [match] = fileReferenceMatches('at src/foo.ts:42 boom')
    assert.equal(match!.candidate, 'src/foo.ts')
    assert.equal(match!.text, 'src/foo.ts:42')
    assert.equal(match!.line, 42)
    assert.equal(match!.column, undefined)
  })

  it('captures a :line:col suffix', () => {
    const [match] = fileReferenceMatches('error src/foo.ts:42:7: unexpected')
    assert.equal(match!.candidate, 'src/foo.ts')
    assert.equal(match!.text, 'src/foo.ts:42:7')
    assert.equal(match!.line, 42)
    assert.equal(match!.column, 7)
    // The link span covers the path and position, not the trailing colon.
    assert.equal(
      'error src/foo.ts:42:7: unexpected'.slice(match!.start, match!.end),
      'src/foo.ts:42:7',
    )
  })

  it('trims trailing prose punctuation from bare paths', () => {
    const [match] = fileReferenceMatches('see renderer.ts.')
    assert.equal(match!.candidate, 'renderer.ts')
    assert.equal(match!.text, 'renderer.ts')
  })

  it('matches well-known extensionless files', () => {
    assert.deepEqual(
      fileReferenceMatches('edit Dockerfile and Makefile').map((m) => m.candidate),
      ['Dockerfile', 'Makefile'],
    )
  })

  it('reports start/end spanning the full reference', () => {
    const text = 'go to src/a/b.ts:10:2 now'
    const [match] = fileReferenceMatches(text)
    assert.equal(text.slice(match!.start, match!.end), 'src/a/b.ts:10:2')
  })
})
