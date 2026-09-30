import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearReasoningReplayForTests,
  reasoningReplayFor,
  type ReplayableReasoning,
} from './reasoning-replay-store.ts'

const item: ReplayableReasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  encrypted_content: 'enc',
}

describe('reasoningReplayFor', () => {
  afterEach(clearReasoningReplayForTests)

  it('hands every provider of one thread and model the same map', () => {
    reasoningReplayFor('gpt-5', 'thread-a').set('call_1', [item])
    assert.deepEqual(reasoningReplayFor('gpt-5', 'thread-a').get('call_1'), [item])
  })

  it('never replays one thread’s or one model’s reasoning into another', () => {
    reasoningReplayFor('gpt-5', 'thread-a').set('call_1', [item])
    assert.equal(reasoningReplayFor('gpt-5', 'thread-b').size, 0)
    assert.equal(reasoningReplayFor('gpt-5-mini', 'thread-a').size, 0)
  })

  it('keeps nothing across providers without a thread key', () => {
    reasoningReplayFor('gpt-5', undefined).set('call_1', [item])
    assert.equal(reasoningReplayFor('gpt-5', undefined).size, 0)
  })

  it('forgets the least recently used thread past its bound', () => {
    reasoningReplayFor('gpt-5', 'oldest').set('call_1', [item])
    for (let i = 0; i < 32; i++) reasoningReplayFor('gpt-5', `thread-${String(i)}`)
    assert.equal(reasoningReplayFor('gpt-5', 'oldest').size, 0)
  })
})
