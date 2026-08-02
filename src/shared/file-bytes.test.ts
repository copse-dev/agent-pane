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
})
