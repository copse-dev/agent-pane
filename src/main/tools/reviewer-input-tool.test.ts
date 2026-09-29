import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewerInputTool } from './reviewer-input-tool.ts'

test('reviewer input tool validates a concrete question and returns without waiting', async () => {
  assert.equal(reviewerInputTool.name, 'request_review_input')
  assert.equal(
    reviewerInputTool.parameters.safeParse({ question: 'Wrap?', context: 'Title clips.' }).success,
    true,
  )
  assert.equal(reviewerInputTool.parameters.safeParse({ question: 'Wrap?' }).success, false)
  const result = await reviewerInputTool.execute(
    { question: 'Wrap?', context: 'Title clips.' },
    new AbortController().signal,
  )
  assert.equal(
    result,
    'Saved for human review. Continue independent work; leave work that depends on this answer pending.',
  )
})
