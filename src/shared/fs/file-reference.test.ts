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

  it('matches directories with a trailing slash, stripping it from the candidate (#506)', () => {
    // `git status` prints untracked directories exactly like this.
    const [match] = fileReferenceMatches('\tsrc/renderer/')
    assert.ok(match)
    assert.equal(match.candidate, 'src/renderer')
    assert.equal(match.text, 'src/renderer/')
    assert.equal('\tsrc/renderer/'.slice(match.start, match.end), 'src/renderer/')
  })

  it('matches dotfiles without a directory prefix (#506)', () => {
    assert.deepEqual(
      fileReferenceMatches('new file: .gitignore, also .env and .eslintrc.json').map(
        (m) => m.candidate,
      ),
      ['.gitignore', '.env', '.eslintrc.json'],
    )
    // A bare ellipsis or sentence dot must not become a link.
    assert.deepEqual(fileReferenceMatches('wait... done.'), [])
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

  it('scans a long run of @/+/$ in linear time', () => {
    // `@`, `+` and `$` are the characters the prefix group and both leading
    // runs all accept, so a run of them is one starting offset per character
    // with the whole remaining run to scan from each. Unbounded that is
    // quadratic: this input took ~12s before the runs were capped.
    const text = '$+a@$+'.repeat(11_000)
    const started = performance.now()
    fileReferenceMatches(text)
    const elapsed = performance.now() - started
    assert.ok(
      elapsed < 2_000,
      `scanning ${String(text.length)} chars took ${elapsed.toFixed(0)}ms; the leading runs are backtracking again`,
    )
  })

  it('still matches paths and stems right up to the length cap', () => {
    // The cap is NAME_MAX, so everything a filesystem can actually hold must
    // still match — the fix is only allowed to drop the unreachable tail.
    const stem = 'a'.repeat(255)
    assert.deepEqual(
      fileReferenceMatches(`see ${stem}.ts here`).map((m) => m.candidate),
      [`${stem}.ts`],
    )
    const segment = 'b'.repeat(255)
    assert.deepEqual(
      fileReferenceMatches(`see src/${segment}/x.ts here`).map((m) => m.candidate),
      [`src/${segment}/x.ts`],
    )
    assert.deepEqual(
      fileReferenceMatches(`see ${segment}/x.ts here`).map((m) => m.candidate),
      [`${segment}/x.ts`],
    )
  })

  it('reports the same candidates as before for everyday text', () => {
    // The scan runs over every user prompt, so the common shapes must keep
    // producing exactly what they produced before the runs were capped —
    // including the pre-existing quirks (an email address and a base64 blob
    // both look enough like `stem.ext` to match, and still do).
    assert.deepEqual(
      fileReferenceMatches('the fix is in src/main/index.ts, see also .env and Makefile').map(
        (m) => m.candidate,
      ),
      ['src/main/index.ts', '.env', 'Makefile'],
    )
    assert.deepEqual(fileReferenceMatches('{"a":1,"b":[2,3]}'), [])
    assert.deepEqual(
      fileReferenceMatches('user@example.com pinged').map((m) => m.candidate),
      ['user@example.com'],
    )
    assert.deepEqual(
      fileReferenceMatches('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q+Pz8/Pw==').map((m) => m.candidate),
      ['aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q+Pz8/Pw'],
    )
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
    const resolved = await resolveFileReferencesInBatches<{ candidate: string }>(['a.ts'], () =>
      Promise.resolve(null),
    )
    assert.deepEqual(resolved, [])
  })
})
