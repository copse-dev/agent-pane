import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatByteSize,
  formatTimestamp,
  frameFileName,
  isVideoFile,
  parseTimePosition,
} from './video-media.ts'

describe('isVideoFile', () => {
  it('accepts anything the browser labels video/*', () => {
    assert.ok(isVideoFile({ name: 'capture', type: 'video/quicktime' }))
  })

  it('falls back to the extension when the MIME type is missing', () => {
    // macOS screen recordings sometimes arrive with an empty File.type.
    assert.ok(isVideoFile({ name: 'Screen Recording.mov', type: '' }))
    assert.ok(isVideoFile({ name: 'demo.WEBM' }))
  })

  it('rejects non-video files', () => {
    assert.equal(isVideoFile({ name: 'shot.png', type: 'image/png' }), false)
    assert.equal(isVideoFile({ name: 'notes.md', type: 'text/markdown' }), false)
  })
})

describe('formatTimestamp', () => {
  it('pads to hh:mm:ss.mmm', () => {
    assert.equal(formatTimestamp(0), '00:00:00.000')
    assert.equal(formatTimestamp(83.45), '00:01:23.450')
    assert.equal(formatTimestamp(3661.5), '01:01:01.500')
  })

  it('clamps negative positions to zero', () => {
    assert.equal(formatTimestamp(-3), '00:00:00.000')
  })

  it('carries a rounded millisecond into the next second', () => {
    assert.equal(formatTimestamp(59.9999), '00:01:00.000')
  })
})

describe('frameFileName', () => {
  it('encodes the timestamp without characters Windows rejects', () => {
    assert.equal(frameFileName(83.45), 'frame-00-01-23.450.webp')
    assert.ok(!frameFileName(83.45).includes(':'))
  })
})

describe('parseTimePosition', () => {
  it('accepts plain seconds', () => {
    assert.equal(parseTimePosition(12), 12)
    assert.equal(parseTimePosition('12.5'), 12.5)
  })

  it('accepts mm:ss and hh:mm:ss', () => {
    assert.equal(parseTimePosition('1:23'), 83)
    assert.equal(parseTimePosition('01:01:01.5'), 3661.5)
  })

  it('rejects malformed and out-of-range input', () => {
    assert.equal(parseTimePosition('soon'), null)
    assert.equal(parseTimePosition(''), null)
    assert.equal(parseTimePosition('1:99'), null)
    assert.equal(parseTimePosition(-4), null)
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
