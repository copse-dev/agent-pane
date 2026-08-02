import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
  detectCrossTurnCircle,
  detectReasoningCircle,
  detectTextRepeatCircle,
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

describe('detectTextRepeatCircle', () => {
  it('recognises a long block re-emitted verbatim in plain visible text', () => {
    const block =
      'The current changes are already present in the working tree, so the request is satisfied. ' +
      'I should confirm the state and move on without applying the same edit again.'
    assert.deepEqual(detectTextRepeatCircle([block, block, block].join('\n\n')), [
      'repeated_block',
      'repeated_sentence',
    ])
  })

  it('does not flag a repeating short motif common in code and formatted output', () => {
    // A tail-cycle detector would flag this (any run of one repeated
    // character trivially cycles); `detectTextRepeatCircle` deliberately
    // excludes that check because it is routine in legitimate output.
    assert.deepEqual(detectTextRepeatCircle('x'.repeat(400)), [])
    assert.deepEqual(detectTextRepeatCircle('-'.repeat(80) + '\n' + '-'.repeat(80)), [])
  })

  it('permits ordinary prose with no exact repeats', () => {
    const text =
      'Updated the resizer test to expect the narrower default width and reran the suite ' +
      'to confirm nothing else regressed.'
    assert.deepEqual(detectTextRepeatCircle(text), [])
  })
})

describe('detectCrossTurnCircle', () => {
  it('recognises the same short turn recurring verbatim across separate calls', () => {
    const turn = 'Checking the same file again to be sure.'
    assert.deepEqual(detectCrossTurnCircle([turn, turn, turn]), ['repeated_turn'])
  })

  it('ignores a short match below the minimum turn length', () => {
    assert.deepEqual(detectCrossTurnCircle(['ok', 'ok', 'ok']), [])
  })

  it('does not flag turns recurring fewer than the repeat limit', () => {
    const turn = 'Checking the same file again to be sure.'
    assert.deepEqual(detectCrossTurnCircle([turn, 'Something else entirely.', turn]), [])
  })

  it('permits distinct turns interspersed with the repeat, matching by content not position', () => {
    const turn = 'Checking the same file again to be sure.'
    assert.deepEqual(
      detectCrossTurnCircle([turn, 'Reading the config next.', turn, 'Now the tests.', turn]),
      ['repeated_turn'],
    )
  })
})
