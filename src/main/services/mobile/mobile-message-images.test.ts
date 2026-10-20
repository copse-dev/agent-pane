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
})
