import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  protectedPromptContentMatches,
  protectedPromptImageDataUrls,
  withProtectedPromptText,
} from '../windows/protected-prompt-review.ts'

test('protected prompt edits preserve image bytes while replacing renderer text', () => {
  const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
  assert.deepEqual(
    withProtectedPromptText(
      [
        { type: 'text', text: 'renderer supplied' },
        image,
        { type: 'text', text: 'more renderer text' },
      ],
      'human reviewed',
    ),
    [{ type: 'text', text: 'human reviewed' }, image],
  )
})

test('protected prompt can send an image without adding unreviewed text', () => {
  const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
  assert.deepEqual(withProtectedPromptText([image], ''), [image])
})

test('protected prompt exposes every model-facing image for isolated review', () => {
  assert.deepEqual(
    protectedPromptImageDataUrls([
      { type: 'text', text: 'review me' },
      { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
      { type: 'image', dataUrl: 'data:image/jpeg;base64,BB==' },
    ]),
    ['data:image/png;base64,AA==', 'data:image/jpeg;base64,BB=='],
  )
})

test('protected prompt accepts a display hint only for exact user content', () => {
  const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
  assert.equal(
    protectedPromptContentMatches(
      [{ type: 'text', text: 'review me' }, image],
      [{ type: 'text', text: 'review me' }, image],
    ),
    true,
  )
  assert.equal(protectedPromptContentMatches('review me', 'different'), false)
  assert.equal(
    protectedPromptContentMatches(
      [{ type: 'text', text: 'review me' }, image],
      [
        { type: 'text', text: 'review me' },
        { ...image, dataUrl: 'data:image/png;base64,forged' },
      ],
    ),
    false,
  )
})
