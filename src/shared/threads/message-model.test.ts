import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import {
  formatPrimaryChatModelLabel,
  formatTurnParameters,
  primaryChatModels,
  shouldShowPrimaryChatModelLabels,
} from './message-model.ts'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'

function assistant(id: string, model?: string, parameters?: ModelParameters): Message {
  return {
    id,
    role: 'assistant',
    content: id,
    toolCalls: [],
    createdAt: 1,
    ...(model !== undefined ? { model } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  }
}

describe('message-model helpers', () => {
  it('collects distinct primary-chat models in first-seen order', () => {
    assert.deepEqual(
      primaryChatModels([
        { id: 'u', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 },
        assistant('a1', 'claude-sonnet-4-6'),
        assistant('a2', 'gpt-5'),
        assistant('a3', 'claude-sonnet-4-6'),
        assistant('a4'),
      ]),
      ['claude-sonnet-4-6', 'gpt-5'],
    )
  })

  it('hides labels for a single primary model (or none)', () => {
    assert.equal(shouldShowPrimaryChatModelLabels([assistant('a1', 'claude-sonnet-4-6')]), false)
    assert.equal(shouldShowPrimaryChatModelLabels([assistant('a1')]), false)
    assert.equal(
      shouldShowPrimaryChatModelLabels([
        assistant('a1', 'claude-sonnet-4-6'),
        assistant('a2', 'claude-sonnet-4-6'),
      ]),
      false,
    )
  })

  it('shows labels once two distinct primary models appear', () => {
    assert.equal(
      shouldShowPrimaryChatModelLabels([
        assistant('a1', 'claude-sonnet-4-6'),
        assistant('a2', 'gpt-5'),
      ]),
      true,
    )
  })

  it('formats local, OpenRouter, Claude-friendly, and best-value ids for the transcript', () => {
    assert.equal(
      formatPrimaryChatModelLabel('lmstudio:qwen/qwen3.6-35b-a3b'),
      'qwen/qwen3.6-35b-a3b · local',
    )
    assert.equal(formatPrimaryChatModelLabel('claude-sonnet-4-6'), 'Claude Sonnet 4.6')
    assert.equal(formatPrimaryChatModelLabel('openrouter:openai/gpt-4o'), 'GPT-4o')
    // An extra-provider selection sheds its routing slug: the transcript names
    // the model, the provider is the picker's grouping.
    assert.equal(formatPrimaryChatModelLabel('deepseek:deepseek-chat'), 'DeepSeek Chat')
    assert.equal(formatPrimaryChatModelLabel('auto:best-value'), 'Best value (plan / price)')
  })
})

describe('turn parameters on the model label', () => {
  it('formats the resolved values compactly', () => {
    assert.equal(formatTurnParameters({ reasoning: 'max' }), 'max effort')
    assert.equal(
      formatTurnParameters({ reasoning: 'max', temperature: 1, topP: 0.95 }),
      'max effort · temp 1 · top-p 0.95',
    )
    assert.equal(formatTurnParameters({ reasoning: 'off' }), 'no thinking')
    assert.equal(formatTurnParameters({ temperature: 0 }), 'temp 0')
  })

  it('says nothing for a turn that sent no parameters', () => {
    assert.equal(formatTurnParameters(undefined), '')
    assert.equal(formatTurnParameters({}), '')
  })

  it('appends them to the model label, and omits them when absent', () => {
    assert.equal(
      formatPrimaryChatModelLabel('claude-opus-4-8', { reasoning: 'xhigh' }),
      'Claude Opus 4.8 · xhigh effort',
    )
    assert.equal(formatPrimaryChatModelLabel('claude-opus-4-8'), 'Claude Opus 4.8')
  })

  it('labels a thread where one model ran at two different depths', () => {
    assert.equal(
      shouldShowPrimaryChatModelLabels([
        assistant('a', 'claude-opus-5'),
        assistant('b', 'claude-opus-5', { reasoning: 'max' }),
      ]),
      true,
    )
  })

  it('leaves a thread that never changed either unlabeled', () => {
    assert.equal(
      shouldShowPrimaryChatModelLabels([
        assistant('a', 'claude-opus-5', { reasoning: 'high' }),
        assistant('b', 'claude-opus-5', { reasoning: 'high' }),
      ]),
      false,
    )
    assert.equal(
      shouldShowPrimaryChatModelLabels([
        assistant('a', 'claude-opus-5'),
        assistant('b', 'claude-opus-5'),
      ]),
      false,
    )
  })
})
