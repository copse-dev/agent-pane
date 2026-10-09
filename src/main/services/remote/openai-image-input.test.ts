import assert from 'node:assert/strict'
import { it } from 'node:test'
import { openAiImageUrls } from './openai-image-input.ts'

const image = { mimeType: 'image/png', data: 'aGVsbG8=' }
it('keeps current images and recent prior images within the transfer budget', () => {
  assert.deepEqual(openAiImageUrls([image]), ['data:image/png;base64,aGVsbG8='])
  assert.equal(
    openAiImageUrls(
      Array.from({ length: 5 }, () => image),
      [image],
    ).length,
    5,
  )
  assert.equal(openAiImageUrls([image], [image]).length, 2)
})
it('rejects unsupported, malformed, excessive and oversized current attachments', () => {
  assert.throws(() => openAiImageUrls([{ ...image, mimeType: 'image/svg+xml' }]), /supports/)
  assert.throws(() => openAiImageUrls([{ ...image, data: 'https://example.com/image' }]), /Invalid/)
  assert.throws(() => openAiImageUrls(Array.from({ length: 6 }, () => image)), /at most 5/)
  assert.throws(
    () => openAiImageUrls([{ ...image, data: 'A'.repeat(28 * 1024 * 1024) }]),
    /oversized/,
  )
})
