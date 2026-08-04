import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage, LLMProvider } from '@shared/types'
import { describeImagesWithProvider } from './image-description.ts'

describe('describeImagesWithProvider', () => {
  it('sends images with a constrained handoff prompt and returns trimmed text', async () => {
    let messages: LLMMessage[] = []
    const provider: LLMProvider = {
      async *stream(input) {
        messages = input
        yield { type: 'text', text: '  A settings panel with a dark theme.  ' }
        yield { type: 'usage', model: 'lmstudio:qwen-vl', inputTokens: 12, outputTokens: 8 }
      },
    }

    const result = await describeImagesWithProvider(
      provider,
      'Does this match the colour section?',
      ['data:image/png;base64,AAAA'],
      100,
    )

    assert.equal(result.text, 'A settings panel with a dark theme.')
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8 })
    const user = messages[0]
    assert.equal(user?.role, 'user')
    assert.ok(user)
    assert.ok(Array.isArray(user.content))
    const content = user.content
    assert.deepEqual(content[0], { type: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    assert.match(content[1]?.type === 'text' ? content[1].text : '', /another AI model/)
    assert.match(
      content[1]?.type === 'text' ? content[1].text : '',
      /Does this match the colour section\?/,
    )
  })

  it('rejects an empty model response', async () => {
    const provider: LLMProvider = {
      async *stream() {
        yield { type: 'done' }
      },
    }
    await assert.rejects(
      () =>
        describeImagesWithProvider(provider, 'Describe this', ['data:image/png;base64,AAAA'], 100),
      /empty description/,
    )
  })
})
