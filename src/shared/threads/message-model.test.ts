import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@shared/types'
import {
  formatPrimaryChatModelLabel,
  primaryChatModels,
  shouldShowPrimaryChatModelLabels,
} from './message-model.ts'

function assistant(id: string, model?: string): Message {
  return {
    id,
    role: 'assistant',
    content: id,
    toolCalls: [],
    createdAt: 1,
    ...(model !== undefined ? { model } : {}),
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

  it('formats local lmstudio ids like the subagent badge', () => {
    assert.equal(
      formatPrimaryChatModelLabel('lmstudio:qwen/qwen3.6-35b-a3b'),
      'qwen/qwen3.6-35b-a3b · local',
    )
    assert.equal(formatPrimaryChatModelLabel('claude-sonnet-4-6'), 'claude-sonnet-4-6')
  })
})
