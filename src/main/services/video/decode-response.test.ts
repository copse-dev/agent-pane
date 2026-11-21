import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { signatureGridFor, signatureLength } from '@shared/video/frame-selection.ts'
import type { DecodeFramesResponse } from '@shared/video/decode-contract.ts'
import { parseDecodeResponse, parseDecodeResponseRequestId } from './decode-response.ts'

const requestId = '6c2bfc3a-9a67-40ec-8a40-fd9649a02dd2'
const signature = Array.from({ length: signatureLength(signatureGridFor(1280, 720)) }, () => 128)
const valid = {
  requestId,
  ok: true,
  durationSeconds: 12,
  sourceWidth: 1920,
  sourceHeight: 1080,
  frameWidth: 1280,
  frameHeight: 720,
  sampleIntervalSeconds: 0.1,
  frames: [{ time: 0, signature, dataUrl: 'data:image/jpeg;base64,/9j/' }],
} satisfies DecodeFramesResponse

describe('video decoder IPC response', () => {
  it('accepts the decoder success and failure shapes', () => {
    assert.deepEqual(parseDecodeResponse(valid), valid)
    const failure = { requestId, ok: false, error: 'Could not decode video' }
    assert.deepEqual(parseDecodeResponse(failure), failure)
  })

  it('ignores malformed or oversized replies before main reads their fields', () => {
    for (const value of [
      null,
      undefined,
      [],
      'not a response',
      { ok: true },
      { ...valid, requestId: 'wrong-id' },
      { ...valid, ok: 'true' },
      { ...valid, durationSeconds: Infinity },
      { ...valid, frameWidth: 20_000 },
      { ...valid, frames: [{ ...valid.frames[0], signature: [128] }] },
      { ...valid, frames: [{ ...valid.frames[0], dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }] },
      { ...valid, frames: [{ ...valid.frames[0], dataUrl: 'data:image/jpeg;base64,</script>' }] },
      { ...valid, frames: [{ ...valid.frames[0], time: NaN }] },
      { ...valid, frames: Array.from({ length: 601 }, () => valid.frames[0]) },
      { ...valid, injected: '<script>unexpected</script>' },
      { requestId, ok: false, error: 'x'.repeat(8193) },
    ]) {
      assert.equal(parseDecodeResponse(value), null)
    }
  })

  it('extracts only a valid correlation id from a malformed reply', () => {
    assert.equal(parseDecodeResponseRequestId({ requestId, injected: '<script>' }), requestId)
    for (const value of [null, {}, { requestId: 'wrong-id' }, { requestId: 42 }]) {
      assert.equal(parseDecodeResponseRequestId(value), null)
    }
  })
})
