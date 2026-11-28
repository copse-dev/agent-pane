import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mobileMessageImages } from './mobile-message-images.ts'

describe('mobile message images', () => {
  it('includes attached, assistant, and tool images without duplicate or external URLs', () => {
    const user = 'data:image/png;base64,dXNlcg=='
    const assistant = 'data:image/webp;base64,YXNzaXN0YW50'
    const tool = 'data:image/jpeg;base64,dG9vbA=='
    assert.deepEqual(
      mobileMessageImages({
        images: [user],
        contentBlocks: [{ type: 'image', dataUrl: assistant, mimeType: 'image/webp' }],
        toolCalls: [
          {
            images: [{ dataUrl: tool }],
            content: [
              {
                type: 'content',
                content: { type: 'image', dataUrl: tool, mimeType: 'image/jpeg' },
              },
              {
                type: 'content',
                content: {
                  type: 'image',
                  dataUrl: 'https://example.com/remote.png',
                  mimeType: 'image/png',
                },
              },
            ],
          },
        ],
      }),
      [user, assistant, tool],
    )
  })

  it('lists a stored tool image by its reference, for the image request to read', () => {
    const stored = 'copse-stored-image:p/t/blobs%2Fa1.tool-0-img-0.dataurl/' + 'a'.repeat(64)
    assert.deepEqual(
      mobileMessageImages({
        toolCalls: [
          {
            images: [{ dataUrl: stored }],
            content: [
              {
                type: 'content',
                content: { type: 'image', dataUrl: stored, mimeType: 'image/png' },
              },
            ],
          },
        ],
      }),
      [stored],
    )
  })
})
