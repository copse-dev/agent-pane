import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLikelyIncompleteText,
  INCOMPLETE_ANSWER_NOTE,
  MAX_INCOMPLETE_CONTINUE_RETRIES,
} from './incomplete-answer.ts'

describe('isLikelyIncompleteText', () => {
  it('treats empty or blank text as complete (handled elsewhere)', () => {
    assert.equal(isLikelyIncompleteText(''), false)
    assert.equal(isLikelyIncompleteText('   \n  '), false)
  })

  it('flags an unclosed fenced code block', () => {
    const text = 'Here is the fix:\n```ts\nconst x = stripDelimiters(input)'
    assert.equal(isLikelyIncompleteText(text), true)
  })

  it('does not flag a balanced fenced code block', () => {
    const text = 'Here is the fix:\n```ts\nconst x = 1\n```\nThat closes it.'
    assert.equal(isLikelyIncompleteText(text), false)
  })

  it('flags a dangling inline-code backtick (the real LM Studio cut-off)', () => {
    // Verbatim tail of the truncated review that motivated this classifier.
    const text =
      'The current `parse-text-tool-calls.ts` handles multiple dialects:\n' +
      '- **MiniMax:** `<invoke>` blocks (often wrapped in `'
    assert.equal(isLikelyIncompleteText(text), true)
  })

  it('does not flag balanced inline code', () => {
    const text = 'It calls `stripMinimaxDelimiters()` before parsing the text.'
    assert.equal(isLikelyIncompleteText(text), false)
  })

  it('flags text ending on a connective or opening character', () => {
    assert.equal(isLikelyIncompleteText('The change spans four layers:'), true)
    assert.equal(isLikelyIncompleteText('This is correct, and'), true)
    assert.equal(isLikelyIncompleteText('Falls back to cancelled —'), true)
    assert.equal(isLikelyIncompleteText('See the diff ('), true)
  })

  it('flags text ending mid-clause on a dangling function word', () => {
    assert.equal(isLikelyIncompleteText("That's probably fine — the"), true)
    assert.equal(isLikelyIncompleteText('writes go through the'), true)
  })

  it('does not flag a normal finished answer', () => {
    assert.equal(
      isLikelyIncompleteText('The fix is targeted and low risk. It passes the existing tests.'),
      false,
    )
    assert.equal(isLikelyIncompleteText('Done. Let me know if you want anything else!'), false)
    assert.equal(isLikelyIncompleteText('Is that what you meant?'), false)
  })

  it('does not flag a heading or list label as incomplete', () => {
    assert.equal(isLikelyIncompleteText('## Architecture overview'), false)
    assert.equal(isLikelyIncompleteText('Issues I found'), false)
  })
})

describe('incomplete-answer constants', () => {
  it('caps continue retries to a small positive number', () => {
    assert.ok((MAX_INCOMPLETE_CONTINUE_RETRIES as number) >= 1)
    assert.ok((MAX_INCOMPLETE_CONTINUE_RETRIES as number) <= 3)
  })

  it('exposes a non-empty user-facing note', () => {
    assert.ok(INCOMPLETE_ANSWER_NOTE.trim().length > 0)
  })
})
