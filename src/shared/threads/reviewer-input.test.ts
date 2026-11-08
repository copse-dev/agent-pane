import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import { formatDeferredAskUserResult } from '@copse/agent/ask-user-format.ts'
import { formatSystemReminder } from '@copse/agent/hooks/inject-context.ts'
import {
  parseReviewerInputAnswers,
  parseReviewerInputCall,
  reviewerInputAnswer,
  reviewerInputRequestsForCall,
  isReviewerInputCall,
} from './reviewer-input.ts'

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

const questions = [
  {
    question: 'Which channel?',
    options: ['Stable', 'Preview'],
    recommendedOption: 'Preview',
    recommendationReason: 'The feature is experimental.',
  },
  { question: 'Who signs off?', options: ['Editor', 'Maintainer'] },
]

const deferred: ToolCall = {
  id: 'questions-1',
  name: 'ask_user',
  status: 'done',
  result: formatDeferredAskUserResult(questions),
  args: { questions },
}

test('unattended questions retain distinct answer identities and the same durable tool anchor', () => {
  const requests = reviewerInputRequestsForCall(deferred, 'message-questions')
  assert.equal(isReviewerInputCall(deferred), true)
  assert.deepEqual(
    requests.map(({ id, toolCallId, messageId, question, options, recommendation }) => ({
      id,
      toolCallId,
      messageId,
      question,
      options,
      recommendation,
    })),
    [
      {
        id: 'questions-1:question:0',
        toolCallId: 'questions-1',
        messageId: 'message-questions',
        question: 'Which channel?',
        options: ['Stable', 'Preview'],
        recommendation: 'Preview — The feature is experimental.',
      },
      {
        id: 'questions-1:question:1',
        toolCallId: 'questions-1',
        messageId: 'message-questions',
        question: 'Who signs off?',
        options: ['Editor', 'Maintainer'],
        recommendation: undefined,
      },
    ],
  )
  assert.match(requests[0]?.context ?? '', /follow-up message/)
})

test('ordinary answered, timed-out, unfinished, failed and malformed asks are not saved again', () => {
  for (const candidate of [
    { ...deferred, result: 'The user answered: Preview' },
    { ...deferred, result: 'The user did not answer.' },
    { ...deferred, status: 'running' as const },
    { ...deferred, status: 'error' as const },
    { ...deferred, args: { questions: [] } },
    { ...deferred, name: 'other_server.ask_user' },
  ])
    assert.deepEqual(reviewerInputRequestsForCall(candidate, 'm'), [])
  assert.equal(isReviewerInputCall({ ...deferred, result: 'The user answered: Preview' }), false)
})

test('recorded hook notes preserve questions without trusting reminder-shaped tool output', () => {
  const note = formatSystemReminder('Retain the review note.')
  const decorated: ToolCall = {
    ...deferred,
    result: `${deferred.result ?? ''}\n\n${note}`,
    appendedReminderLengths: [note.length],
  }
  assert.equal(isReviewerInputCall(decorated), true)
  assert.deepEqual(
    reviewerInputRequestsForCall(decorated, 'm'),
    reviewerInputRequestsForCall(deferred, 'm'),
  )
  for (const candidate of [
    { ...decorated, appendedReminderLengths: [] },
    { ...decorated, appendedReminderLengths: [note.length - 1] },
    { ...decorated, appendedReminderLengths: [-1] },
    { ...decorated, result: `${deferred.result ?? ''}\n\nordinary prose` },
    { ...decorated, result: `The user answered: Preview\n\n${note}` },
    { ...decorated, name: 'other_server.ask_user' },
    { ...deferred, result: decorated.result },
  ]) {
    assert.equal(isReviewerInputCall(candidate), false)
    assert.deepEqual(reviewerInputRequestsForCall(candidate, 'm'), [])
  }
})

test('ACP envelopes preserve saved questions only for the matching Copse tool', () => {
  const wrapped: ToolCall = {
    ...deferred,
    name: 'mcp__copse__ask_user',
    args: { server: 'copse', tool: 'ask_user', arguments: deferred.args },
  }
  assert.deepEqual(
    reviewerInputRequestsForCall(wrapped, 'm'),
    reviewerInputRequestsForCall(deferred, 'm'),
  )
  assert.equal(
    parseReviewerInputCall(
      {
        ...call,
        name: 'mcp__copse__request_review_input',
        args: {
          server: 'copse',
          tool: 'request_review_input',
          arguments: call.args,
        },
      },
      'm',
    )?.question,
    'Wrap the title?',
  )
  for (const args of [
    { server: 'other', tool: 'ask_user', arguments: deferred.args },
    { server: 'copse', tool: 'request_review_input', arguments: deferred.args },
    { server: 'copse', tool: 'ask_user', arguments: null },
  ])
    assert.deepEqual(reviewerInputRequestsForCall({ ...wrapped, args }, 'm'), [])
})

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
  assert.deepEqual(reviewerInputAnswer([answer], 'request-1'), answer)
  assert.equal(reviewerInputAnswer([answer], 'request-2'), undefined)
})

test('persisted answer decoding drops malformed entries without crashing lookup', () => {
  const answer = { id: 'request-1', text: 'Wrap', answeredAt: 1, messageId: 'm3' }
  assert.deepEqual(parseReviewerInputAnswers([answer, null, { ...answer, answeredAt: 'now' }]), [
    answer,
  ])
  assert.deepEqual(parseReviewerInputAnswers({ id: 'not-an-array' }), [])
  assert.equal(reviewerInputAnswer('corrupt', 'request-1'), undefined)
})
