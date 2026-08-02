import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isArchiveFile } from './archive-media.ts'

describe('isArchiveFile', () => {
  it('accepts a .zip whatever the browser claims its type is', () => {
    assert.equal(isArchiveFile({ name: 'bundle.zip' }), true)
    assert.equal(isArchiveFile({ name: 'Bundle.ZIP', type: '' }), true)
    assert.equal(isArchiveFile({ name: 'bundle.zip', type: 'application/octet-stream' }), true)
  })

  it('accepts the zip MIME types even when the name has no extension', () => {
    assert.equal(isArchiveFile({ name: 'download', type: 'application/zip' }), true)
    assert.equal(isArchiveFile({ name: 'download', type: 'application/x-zip-compressed' }), true)
  })

  it('rejects formats the reader cannot open', () => {
    assert.equal(isArchiveFile({ name: 'bundle.tar.gz' }), false)
    assert.equal(isArchiveFile({ name: 'notes.md', type: 'text/markdown' }), false)
    assert.equal(isArchiveFile({ name: 'clip.mp4', type: 'video/mp4' }), false)
  })
})
