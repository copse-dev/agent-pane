import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_VIDEO_BYTES } from '@shared/video/video-media.ts'
import {
  RECORDING_MAX_BYTES,
  RECORDING_MAX_DURATION_MS,
  pickRecordingMimeType,
  recordingLimitReached,
} from './canvas-recorder.ts'

describe('pickRecordingMimeType', () => {
  it('prefers VP9, then VP8, then plain WebM', () => {
    assert.equal(
      pickRecordingMimeType(() => true),
      'video/webm;codecs=vp9',
    )
    assert.equal(
      pickRecordingMimeType((t) => !t.includes('vp9')),
      'video/webm;codecs=vp8',
    )
    assert.equal(
      pickRecordingMimeType((t) => t === 'video/webm'),
      'video/webm',
    )
  })

  it('returns null when nothing WebM can be encoded', () => {
    assert.equal(
      pickRecordingMimeType(() => false),
      null,
    )
  })
})

describe('recordingLimitReached', () => {
  it('keeps recording inside both budgets', () => {
    assert.equal(
      recordingLimitReached(RECORDING_MAX_DURATION_MS - 1, RECORDING_MAX_BYTES - 1),
      null,
    )
  })

  it('stops at the duration limit', () => {
    assert.equal(recordingLimitReached(RECORDING_MAX_DURATION_MS, 0), 'duration-limit')
  })

  it('stops at the size limit, which wins when both are reached', () => {
    assert.equal(recordingLimitReached(0, RECORDING_MAX_BYTES), 'size-limit')
    assert.equal(
      recordingLimitReached(RECORDING_MAX_DURATION_MS, RECORDING_MAX_BYTES),
      'size-limit',
    )
  })

  it('leaves room under the chat video cap for the final chunk', () => {
    assert.ok(RECORDING_MAX_BYTES < MAX_VIDEO_BYTES)
  })
})
