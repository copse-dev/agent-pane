import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  consumeProtectedPromptMessageAppend,
  hasProtectedPromptMessageAppend,
  recordProtectedPromptMessageAppend,
  revokeProtectedPromptMessageAppends,
} from './protected-prompt-receipts.ts'

test('protected prompt append proof is sender-bound and one-use', () => {
  recordProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message')

  assert.equal(hasProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), true)
  assert.equal(hasProtectedPromptMessageAppend(11, 'project', 'thread', 'new-message'), false)
  assert.equal(consumeProtectedPromptMessageAppend(11, 'project', 'thread', 'new-message'), false)
  assert.equal(consumeProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), true)
  assert.equal(hasProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), false)
})

test('retirement revokes the same message identity across every sender only', () => {
  recordProtectedPromptMessageAppend(20, 'project', 'thread', 'retired-message')
  recordProtectedPromptMessageAppend(21, 'project', 'thread', 'retired-message')
  recordProtectedPromptMessageAppend(20, 'project', 'thread', 'kept-message')
  recordProtectedPromptMessageAppend(20, 'other-project', 'thread', 'retired-message')

  revokeProtectedPromptMessageAppends('project', 'thread', 'retired-message')

  assert.equal(hasProtectedPromptMessageAppend(20, 'project', 'thread', 'retired-message'), false)
  assert.equal(hasProtectedPromptMessageAppend(21, 'project', 'thread', 'retired-message'), false)
  assert.equal(hasProtectedPromptMessageAppend(20, 'project', 'thread', 'kept-message'), true)
  assert.equal(
    hasProtectedPromptMessageAppend(20, 'other-project', 'thread', 'retired-message'),
    true,
  )
})
