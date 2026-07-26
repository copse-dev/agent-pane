import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
  detectReasoningCircle,
} from './reasoning-circle-detector.ts'

describe('reasoning circle detector', () => {
  it('does not treat common Qwen planning language as a circle', () => {
    const reasoning =
      'Actually, I need to inspect the implementation first. Let me start with the caller, ' +
      'then I will update the focused test and run it once. That is enough evidence to proceed.'
    assert.deepEqual(detectReasoningCircle(reasoning), [])
  })

  it('recognises explicit first-person self-diagnosis', () => {
    assert.deepEqual(
      detectReasoningCircle("Wait. I think I'm overcomplicating this; I should stop."),
      ['self_reported_circle'],
    )
    assert.deepEqual(
      detectReasoningCircle("I'm going in circles and keep arriving at the same answer."),
      ['self_reported_circle'],
    )
  })

  it('recognises a long block re-emitted at least three times', () => {
    const block =
      'The current changes are already present in the working tree, so the request is satisfied. ' +
      'I should confirm the state and move on without applying the same edit again.'
    assert.deepEqual(detectReasoningCircle([block, block, block].join('\n\n')), [
      'repeated_block',
      'repeated_sentence',
    ])
  })

  it('recognises a sentence repeated inside one unbroken wall of prose', () => {
    // A token-level repeat loop streams no blank lines, so `repeated_block` sees
    // a single block; the sentence and tail signals are what catch it.
    const unit =
      'I need to reconsider what the user is asking, because the pane should be ' +
      'one third of the shared area and the chat should keep the other two thirds. '
    assert.deepEqual(detectReasoningCircle(unit.repeat(4)), ['repeated_sentence', 'repeated_tail'])
  })

  it('recognises a repeating tail with no sentence punctuation to split on', () => {
    const fragment = 'maxRatio 2/3 -> files pane capped at 1/3 -> expect 506px not 253px '
    assert.deepEqual(detectReasoningCircle(fragment.repeat(5)), ['repeated_tail'])
  })

  it('permits a long answer that merely revisits the same short phrase', () => {
    const reasoning = [
      'Let me check the resizer test.',
      'The layout defaults live in a shared module, so I will read that first and',
      'then confirm which ratio the chat pane keeps once the files pane is capped.',
      'Let me check the resizer test.',
      'That matches, so the remaining work is to update the expectation to 253px.',
      'Let me check the resizer test.',
    ].join('\n')
    assert.deepEqual(detectReasoningCircle(reasoning), [])
  })

  it('recognises headings and multi-item plans that recur again and again', () => {
    const unit = `Next plan:
1. Inspect the current state
2. Restore the missing change
3. Confirm the result`
    assert.deepEqual(detectReasoningCircle([unit, unit, unit].join('\n\n')), [
      'repeated_heading',
      'repeated_plan',
    ])
  })

  it('recognises runaway enumeration but permits ordinary short lists', () => {
    const short = Array.from(
      { length: 20 },
      (_, index) => `${String(index + 1)}. item ${String(index)}`,
    )
    const long = Array.from(
      { length: DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS.maxListItems },
      (_, index) => `${String(index + 1)}. unique item ${String(index)}`,
    )
    assert.deepEqual(detectReasoningCircle(short.join('\n')), [])
    assert.deepEqual(detectReasoningCircle(long.join('\n')), ['runaway_list'])
  })
})
