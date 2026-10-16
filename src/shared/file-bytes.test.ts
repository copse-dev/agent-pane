import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileExtension, formatByteSize } from './file-bytes.ts'

describe('fileExtension', () => {
  it('lower-cases the last dotted segment', () => {
    assert.equal(fileExtension('Archive.ZIP'), '.zip')
    assert.equal(fileExtension('a.tar.gz'), '.gz')
  })

  it('returns empty for a name with no dot', () => {
    assert.equal(fileExtension('Makefile'), '')
  })
})

describe('formatByteSize', () => {
  it('scales to the largest unit that keeps the number small', () => {
    assert.equal(formatByteSize(512), '512 B')
    assert.equal(formatByteSize(1536), '1.5 KB')
    assert.equal(formatByteSize(5 * 1024 * 1024), '5.0 MB')
    assert.equal(formatByteSize(1024 * 1024 * 1024), '1.0 GB')
  })

  it('rolls over to the next unit when rounding reaches 1024', () => {
    const cases: Array<[number, string]> = [
      [1023, '1023 B'],
      [1024, '1.0 KB'],
      [10_188, '9.9 KB'],
      [10_200, '10 KB'],
      [1_048_575, '1.0 MB'],
      [1024 * 1024 * 1024 - 1, '1.0 GB'],
      [2048 * 1024 * 1024 * 1024, '2048 GB'],
    ]
    for (const [bytes, expected] of cases)
      assert.equal(formatByteSize(bytes), expected, String(bytes))
  })

  it('does not print NaN for a non-finite or negative size', () => {
    for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(formatByteSize(bytes), 'unknown size')
    }
  })
})
