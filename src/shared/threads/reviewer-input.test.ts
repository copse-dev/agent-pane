import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import { parseReviewerInputCall, reviewerInputAnswer } from './reviewer-input.ts'

const call: ToolCall = {
  id: 'request-1',
  name: 'request_review_input',
  status: 'done',
  result: 'Saved',
  args: {
    question: 'Wrap the title?',
    context: 'The narrow layout clips it.',
    recommendation: 'Use two lines.',
    options: ['Wrap', 'Truncate'],
  },
}

test('saved reviewer request uses its tool call and owning message as stable anchors', () => {
  assert.deepEqual(parseReviewerInputCall(call, 'message-2'), {
    id: 'request-1',
    messageId: 'message-2',
    question: 'Wrap the title?',
    context: 'The narrow layout clips it.',
    recommendation: 'Use two lines.',
    options: ['Wrap', 'Truncate'],
  })
})

test('ACP bridge names resolve to the same request and unfinished calls do not surface', () => {
  assert.ok(parseReviewerInputCall({ ...call, name: 'mcp__copse__request_review_input' }, 'm2'))
  assert.ok(
    parseReviewerInputCall(
      { ...call, name: 'copse-request_review_input: request_review_input' },
      'm2',
    ),
  )
  assert.equal(parseReviewerInputCall({ ...call, status: 'running' }, 'm2'), null)
  assert.equal(parseReviewerInputCall({ ...call, status: 'error' }, 'm2'), null)
  assert.equal(
    parseReviewerInputCall({ ...call, args: { question: 'Missing context' } }, 'm2'),
    null,
  )
})

test('answer lookup is scoped to the request id', () => {
  const answer = { id: 'request-1', text: 'Wrap', answeredAt: 1, messageId: 'm3' }
  assert.equal(reviewerInputAnswer([answer], 'request-1'), answer)
  assert.equal(reviewerInputAnswer([answer], 'request-2'), undefined)
})
