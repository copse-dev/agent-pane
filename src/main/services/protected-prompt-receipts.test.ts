import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  consumeProtectedPromptMessageAppend,
  hasProtectedPromptMessageAppend,
  recordProtectedPromptMessageAppend,
  recordProtectedPromptThreadCreate,
} from './protected-prompt-receipts.ts'

test('protected prompt append proof is sender-bound and one-use', () => {
  recordProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message')

  assert.equal(hasProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), true)
  assert.equal(hasProtectedPromptMessageAppend(11, 'project', 'thread', 'new-message'), false)
  assert.equal(consumeProtectedPromptMessageAppend(11, 'project', 'thread', 'new-message'), false)
  assert.equal(consumeProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), true)
  assert.equal(hasProtectedPromptMessageAppend(10, 'project', 'thread', 'new-message'), false)
})

test('idempotent thread creation cannot mint proof for a historical prompt', () => {
  const historical = [{ id: 'historical-message', role: 'user' as const }]
  recordProtectedPromptThreadCreate(20, 'project', 'existing-thread', false, historical)
  assert.equal(
    hasProtectedPromptMessageAppend(20, 'project', 'existing-thread', 'historical-message'),
    false,
  )

  recordProtectedPromptThreadCreate(20, 'project', 'fresh-thread', true, [
    { id: 'fresh-message', role: 'user' },
  ])
  assert.equal(
    consumeProtectedPromptMessageAppend(20, 'project', 'fresh-thread', 'fresh-message'),
    true,
  )
})
