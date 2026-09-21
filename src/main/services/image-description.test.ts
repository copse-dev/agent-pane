import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage, LLMProvider } from '@shared/types'
import { parseUsageEvents } from '@shared/usage/aggregate-usage.ts'
import { USAGE_EVENTS_STORAGE_KEY } from '@shared/usage/usage-event.ts'
import { describeImagesForHandoff, describeImagesWithProvider } from './image-description.ts'
import { storageGet, storageSet } from './storage/storage.ts'

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

  it('attributes a pre-send handoff to its blank thread and selected model', async () => {
    const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
    const previousUsageEvents = storageGet(USAGE_EVENTS_STORAGE_KEY)
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    storageSet(USAGE_EVENTS_STORAGE_KEY, [])

    try {
      const result = await describeImagesForHandoff({
        projectId: 'blank-project',
        threadId: 'blank-thread-before-first-message',
        model: 'openrouter:anthropic/claude-sonnet-4',
        userPrompt: 'What is visible?',
        images: ['data:image/png;base64,AAAA'],
      })

      assert.match(result.text, /Mock response/)
      const events = parseUsageEvents(storageGet(USAGE_EVENTS_STORAGE_KEY))
      assert.equal(events.length, 1)
      const event = events[0]
      assert.ok(event)
      assert.equal(typeof event.at, 'number')
      assert.deepEqual(
        { ...event, at: 0 },
        {
          at: 0,
          model: 'openrouter:anthropic/claude-sonnet-4',
          source: 'small-tasks',
          projectId: 'blank-project',
          threadId: 'blank-thread-before-first-message',
          inputTokens: 120,
          outputTokens: 80,
        },
      )
    } finally {
      if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
      else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
      storageSet(USAGE_EVENTS_STORAGE_KEY, previousUsageEvents)
    }
  })
})
