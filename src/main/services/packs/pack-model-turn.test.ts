import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boundedPackModelHistory, buildPackModelTurn } from './pack-model-turn.ts'

describe('pack model turn', () => {
  it('passes validated current images and a text-only bounded handoff', () => {
    const turn = buildPackModelTurn({
      threadId: 'thread-1',
      prompt: [
        { type: 'image', dataUrl: 'data:image/png;base64,QUJD' },
        { type: 'text', text: 'judge this' },
      ],
      priorMessages: [
        {
          role: 'user',
          content: [
            { type: 'image', dataUrl: 'data:image/jpeg;base64,QUJD' },
            { type: 'text', text: 'earlier' },
          ],
        },
        { role: 'assistant', content: 'earlier answer' },
      ],
      supportsImages: true,
    })

    assert.deepEqual(turn, {
      threadId: 'thread-1',
      prompt: 'judge this',
      attachments: [{ mimeType: 'image/png', dataBase64: 'QUJD' }],
      history: [
        { role: 'user', text: '[Image omitted from transcript handoff]\nearlier' },
        { role: 'assistant', text: 'earlier answer' },
      ],
    })
  })

  it('fails clearly instead of silently dropping unsupported current images', () => {
    assert.throws(
      () =>
        buildPackModelTurn({
          threadId: 'thread-1',
          prompt: [{ type: 'image', dataUrl: 'data:image/png;base64,QUJD' }],
          priorMessages: [],
          supportsImages: false,
        }),
      /does not accept image attachments/i,
    )
  })

  it('rejects malformed or non-canonical image payloads', () => {
    assert.throws(
      () =>
        buildPackModelTurn({
          threadId: 'thread-1',
          prompt: [{ type: 'image', dataUrl: 'data:image/png;base64,A' }],
          priorMessages: [],
          supportsImages: true,
        }),
      /canonical base64/i,
    )
  })

  it('caps current-turn image count before crossing the worker protocol', () => {
    assert.throws(
      () =>
        buildPackModelTurn({
          threadId: 'thread-1',
          prompt: Array.from({ length: 9 }, () => ({
            type: 'image' as const,
            dataUrl: 'data:image/png;base64,QUJD',
          })),
          priorMessages: [],
          supportsImages: true,
        }),
      /at most 8 images/i,
    )
  })

  it('bounds transcript handoff to the newest 32 messages and 64K characters', () => {
    const history = boundedPackModelHistory(
      Array.from({ length: 40 }, (_, index) => ({
        role: 'user' as const,
        content: `${String(index)}:${'x'.repeat(3_000)}`,
      })),
    )
    assert.ok(history.length <= 32)
    assert.ok(history.reduce((sum, message) => sum + message.text.length, 0) <= 64 * 1024)
    assert.match(history.at(-1)?.text ?? '', /^39:/)
  })
})
