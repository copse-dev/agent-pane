import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fileReferenceMatches,
  FILE_REFERENCE_RESOLVE_BATCH_SIZE,
  resolveFileReferencesInBatches,
} from './file-reference.ts'

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
    assert.ok(match)
    assert.equal(match.candidate, 'src/foo.ts')
    assert.equal(match.text, 'src/foo.ts:42')
    assert.equal(match.line, 42)
    assert.equal(match.column, undefined)
  })

  it('captures a :line:col suffix', () => {
    const [match] = fileReferenceMatches('error src/foo.ts:42:7: unexpected')
    assert.ok(match)
    assert.equal(match.candidate, 'src/foo.ts')
    assert.equal(match.text, 'src/foo.ts:42:7')
    assert.equal(match.line, 42)
    assert.equal(match.column, 7)
    // The link span covers the path and position, not the trailing colon.
    assert.equal(
      'error src/foo.ts:42:7: unexpected'.slice(match.start, match.end),
      'src/foo.ts:42:7',
    )
  })

  it('trims trailing prose punctuation from bare paths', () => {
    const [match] = fileReferenceMatches('see renderer.ts.')
    assert.ok(match)
    assert.equal(match.candidate, 'renderer.ts')
    assert.equal(match.text, 'renderer.ts')
  })

  it('matches well-known extensionless files', () => {
    assert.deepEqual(
      fileReferenceMatches('edit Dockerfile and Makefile').map((m) => m.candidate),
      ['Dockerfile', 'Makefile'],
    )
  })

  it('matches hyphenated filenames', () => {
    const [match] = fileReferenceMatches('see DEVELOPMENT-NOTES.md next')
    assert.ok(match)
    assert.equal(match.candidate, 'DEVELOPMENT-NOTES.md')
    assert.equal(match.text, 'DEVELOPMENT-NOTES.md')
  })

  it('reports start/end spanning the full reference', () => {
    const text = 'go to src/a/b.ts:10:2 now'
    const [match] = fileReferenceMatches(text)
    assert.ok(match)
    assert.equal(text.slice(match.start, match.end), 'src/a/b.ts:10:2')
  })
})

describe('resolveFileReferencesInBatches', () => {
  it('splits candidates into batches that respect the IPC cap', async () => {
    const candidates = Array.from(
      { length: FILE_REFERENCE_RESOLVE_BATCH_SIZE * 2 + 5 },
      (_, i) => `file-${String(i)}.ts`,
    )
    const batchSizes: number[] = []
    const resolved = await resolveFileReferencesInBatches(candidates, (batch) => {
      batchSizes.push(batch.length)
      return Promise.resolve(batch.map((candidate) => ({ candidate })))
    })

    assert.deepEqual(batchSizes, [
      FILE_REFERENCE_RESOLVE_BATCH_SIZE,
      FILE_REFERENCE_RESOLVE_BATCH_SIZE,
      5,
    ])
    assert.equal(resolved.length, candidates.length)
    assert.deepEqual(
      resolved.map((r) => r.candidate),
      candidates,
    )
  })

  it('returns an empty array for no candidates without calling resolve', async () => {
    let calls = 0
    const resolved = await resolveFileReferencesInBatches<{ candidate: string }>([], () => {
      calls += 1
      return Promise.resolve([])
    })
    assert.deepEqual(resolved, [])
    assert.equal(calls, 0)
  })

  it('guards a null result from the IPC boundary', async () => {
    const resolved = await resolveFileReferencesInBatches(['a.ts'], () =>
      Promise.resolve(null as unknown as { candidate: string }[]),
    )
    assert.deepEqual(resolved, [])
  })
})
