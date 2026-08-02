import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatTimestamp, frameFileName, isVideoFile, parseTimePosition } from './video-media.ts'

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

  it('drops the components a short recording can never reach', () => {
    // The manifest repeats this on every frame line, so hours and minutes a
    // 10-second clip cannot reach are pure tokens.
    assert.equal(formatTimestamp(3.386, 10), '3.386s')
    assert.equal(formatTimestamp(83.45, 120), '01:23.450')
    assert.equal(formatTimestamp(83.45, 7200), '00:01:23.450')
  })

  it('never shortens below what the timestamp itself needs', () => {
    // A duration that under-reports the position must not truncate it.
    assert.equal(formatTimestamp(83.45, 10), '01:23.450')
  })

  it('emits forms that parseTimePosition accepts', () => {
    // The model hands these straight back as start/end, so a format the parser
    // rejects would make the tool's own output unusable as its own input.
    for (const duration of [10, 120, 7200]) {
      const rendered = formatTimestamp(83.45, duration)
      assert.equal(parseTimePosition(rendered), 83.45, `${rendered} did not round-trip`)
    }
  })
})

describe('frameFileName', () => {
  it('encodes the timestamp without characters Windows rejects', () => {
    assert.equal(frameFileName(83.45, 'jpg'), 'frame-00-01-23.450.jpg')
    assert.ok(!frameFileName(83.45, 'jpg').includes(':'))
  })

  it('scales the name to the recording it came from', () => {
    assert.equal(frameFileName(3.386, 'jpg', 57), 'frame-3.386s.jpg')
    assert.equal(frameFileName(83.45, 'jpg', 120), 'frame-01-23.450.jpg')
  })
})

describe('parseTimePosition', () => {
  it('accepts plain seconds', () => {
    assert.equal(parseTimePosition(12), 12)
    assert.equal(parseTimePosition('12.5'), 12.5)
  })

  it('accepts a trailing s, the form frame names and models both use', () => {
    assert.equal(parseTimePosition('12.5s'), 12.5)
    assert.equal(parseTimePosition('3s'), 3)
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
