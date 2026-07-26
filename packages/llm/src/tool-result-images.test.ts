import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage } from './wire-types.ts'
import {
  IMAGE_DROPPED_NOTE,
  dropImageContent,
  isSupportedToolResultImage,
  stripToolResultImages,
  toolResultContentBlocks,
  toolResultImageFollowUp,
} from './tool-result-images.ts'

const PNG = 'data:image/png;base64,AAAA'
const WEBP = 'data:image/webp;base64,BBBB'

describe('isSupportedToolResultImage', () => {
  it('accepts base64 image data URLs', () => {
    assert.ok(isSupportedToolResultImage({ dataUrl: PNG }))
    assert.ok(isSupportedToolResultImage({ dataUrl: WEBP }))
  })

  it('rejects remote URLs and non-image payloads', () => {
    assert.equal(isSupportedToolResultImage({ dataUrl: 'https://example.com/a.png' }), false)
    assert.equal(isSupportedToolResultImage({ dataUrl: 'data:text/plain;base64,QQ==' }), false)
  })
})

describe('toolResultContentBlocks', () => {
  it('returns null when a result has no images, so the plain string form is kept', () => {
    assert.equal(toolResultContentBlocks({ toolCallId: 't1', result: 'ok' }), null)
    assert.equal(toolResultContentBlocks({ toolCallId: 't1', result: 'ok', images: [] }), null)
  })

  it('leads with the text result, then labels each image by name', () => {
    const blocks = toolResultContentBlocks({
      toolCallId: 't1',
      result: '2 frames',
      images: [
        { dataUrl: WEBP, name: 'frame-00-00-00.000.webp' },
        { dataUrl: WEBP, name: 'frame-00-00-04.500.webp' },
      ],
    })
    assert.deepEqual(blocks, [
      { type: 'text', text: '2 frames' },
      { type: 'text', text: 'frame-00-00-00.000.webp' },
      { type: 'image', dataUrl: WEBP },
      { type: 'text', text: 'frame-00-00-04.500.webp' },
      { type: 'image', dataUrl: WEBP },
    ])
  })

  it('drops unsupported payloads rather than sending them to a provider', () => {
    const blocks = toolResultContentBlocks({
      toolCallId: 't1',
      result: 'ok',
      images: [{ dataUrl: 'https://example.com/a.png' }],
    })
    assert.equal(blocks, null)
  })
})

describe('toolResultImageFollowUp', () => {
  it('returns null when no result in the batch carries images', () => {
    assert.equal(toolResultImageFollowUp([{ toolCallId: 't1', result: 'ok' }]), null)
  })

  it('gathers images from every result in the batch', () => {
    const content = toolResultImageFollowUp([
      { toolCallId: 't1', result: 'a', images: [{ dataUrl: PNG, name: 'a.png' }] },
      { toolCallId: 't2', result: 'b' },
      { toolCallId: 't3', result: 'c', images: [{ dataUrl: WEBP, name: 'c.webp' }] },
    ])
    assert.ok(Array.isArray(content))
    assert.deepEqual(
      content.filter((b) => b.type === 'image'),
      [
        { type: 'image', dataUrl: PNG },
        { type: 'image', dataUrl: WEBP },
      ],
    )
    // A leading note plus one label per image explains where they came from.
    assert.equal(content.filter((b) => b.type === 'text').length, 3)
  })
})

describe('stripToolResultImages', () => {
  it('leaves a history with no tool-result images alone', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolResults: [{ toolCallId: 't1', result: 'ok' }] },
    ]
    assert.deepEqual(stripToolResultImages(messages), messages)
  })

  it('removes images while keeping the text result and every other message', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'image', dataUrl: PNG }] },
      {
        role: 'tool',
        toolResults: [
          { toolCallId: 't1', result: '3 frames', images: [{ dataUrl: WEBP, name: 'f.webp' }] },
          { toolCallId: 't2', result: 'ok' },
        ],
      },
    ]
    const stripped = stripToolResultImages(messages)
    assert.deepEqual(stripped[0], messages[0], 'user-attached images are unaffected')
    assert.deepEqual(stripped[1], {
      role: 'tool',
      toolResults: [
        { toolCallId: 't1', result: '3 frames' },
        { toolCallId: 't2', result: 'ok' },
      ],
    })
  })

  it('does not mutate the input', () => {
    const messages: LLMMessage[] = [
      {
        role: 'tool',
        toolResults: [{ toolCallId: 't1', result: 'x', images: [{ dataUrl: PNG }] }],
      },
    ]
    stripToolResultImages(messages)
    assert.equal(messages[0]?.role === 'tool' && messages[0].toolResults[0]?.images?.length, 1)
  })
})

describe('dropImageContent', () => {
  it('leaves a request with no images untouched', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolResults: [{ toolCallId: 't1', result: 'ok' }] },
    ]
    assert.deepEqual(dropImageContent(messages), messages)
  })

  it('replaces a user-attached image with a note the model can read', () => {
    const [message] = dropImageContent([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', dataUrl: PNG },
        ],
      },
    ])
    assert.deepEqual(message, {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'text', text: IMAGE_DROPPED_NOTE },
      ],
    })
  })

  it("keeps a tool result's text and appends the note in place of its images", () => {
    // The manifest still names every frame and timestamp, so the model can say
    // what it could not see rather than inventing what it showed.
    const [message] = dropImageContent([
      {
        role: 'tool',
        toolResults: [
          { toolCallId: 't1', result: '3 frames', images: [{ dataUrl: WEBP, name: 'f.jpg' }] },
          { toolCallId: 't2', result: 'no images here' },
        ],
      },
    ])
    assert.deepEqual(message, {
      role: 'tool',
      toolResults: [
        { toolCallId: 't1', result: `3 frames\n\n${IMAGE_DROPPED_NOTE}` },
        { toolCallId: 't2', result: 'no images here' },
      ],
    })
  })

  it('does not mutate the input', () => {
    const original: LLMMessage = { role: 'user', content: [{ type: 'image', dataUrl: PNG }] }
    dropImageContent([original])
    assert.deepEqual(original.content, [{ type: 'image', dataUrl: PNG }])
  })
})
