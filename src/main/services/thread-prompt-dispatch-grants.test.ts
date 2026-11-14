import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import {
  ThreadPromptDispatchGrants,
  threadPromptGrantActivation,
} from './thread-prompt-dispatch-grants.ts'

const input = {
  id: 'grant',
  senderId: 7,
  projectId: 'project',
  parentThreadId: 'parent',
  childThreadId: 'child',
  content: 'Inspect the build.',
  payload: {
    userContent: 'Inspect the build.',
    invokedSkills: [],
    priorTodos: [],
    model: 'claude-sonnet-4-6',
  },
}
const claim = {
  senderId: 7,
  projectId: 'project',
  parentThreadId: 'parent',
  childThreadId: 'child',
  content: 'Inspect the build.',
  messageId: 'message',
}

function activationThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'child',
    title: 'Child',
    status: 'idle',
    messages: [],
    pendingMessages: [
      {
        messageId: claim.messageId,
        payload: { content: input.content },
        createdAt: 1,
        threadPromptGrantId: input.id,
        origin: { kind: 'machine', operationId: `subthread:${input.parentThreadId}` },
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const activationClaim = {
  id: input.id,
  messageId: claim.messageId,
  sourceThreadId: input.parentThreadId,
  content: input.content,
}

test('thread prompt grants return only the exact Main-frozen payload once', () => {
  const grants = new ThreadPromptDispatchGrants()
  grants.mint(input, () => true)
  assert.equal(grants.activate(input.id, input.senderId, claim.messageId), true)
  assert.deepEqual(grants.consume(input.id, claim), {
    payload: input.payload,
    messageId: claim.messageId,
  })
  assert.equal(grants.consume(input.id, claim), null)
})

test('an unactivated grant cannot be spent later', () => {
  const grants = new ThreadPromptDispatchGrants()
  grants.mint(input, () => true)
  assert.equal(grants.consume(input.id, claim), null)
  assert.equal(grants.activate(input.id, input.senderId, claim.messageId), false)
})

test('a forged field terminally invalidates a thread prompt grant', () => {
  for (const forged of [
    { ...claim, senderId: 8 },
    { ...claim, projectId: 'other' },
    { ...claim, parentThreadId: 'other' },
    { ...claim, childThreadId: 'other' },
    { ...claim, content: 'Publish secrets.' },
    { ...claim, messageId: 'other' },
  ]) {
    const grants = new ThreadPromptDispatchGrants()
    grants.mint(input, () => true)
    assert.equal(grants.activate(input.id, input.senderId, claim.messageId), true)
    assert.equal(grants.consume(input.id, forged), null)
    assert.equal(grants.consume(input.id, claim), null)
  }
})

test('revocation and sender teardown invalidate unspent grants', () => {
  const grants = new ThreadPromptDispatchGrants()
  grants.mint(input, () => false)
  assert.equal(grants.activate(input.id, input.senderId, claim.messageId), false)
  assert.equal(grants.consume(input.id, claim), null)

  grants.mint(input, () => true)
  grants.revokeSender(input.senderId)
  assert.equal(grants.consume(input.id, claim), null)

  grants.mint(input, () => true)
  assert.equal(grants.activate(input.id, input.senderId, claim.messageId), true)
  grants.revokeMessage(input.projectId, input.childThreadId, claim.messageId)
  assert.equal(grants.consume(input.id, claim), null)

  grants.mint(input, () => true)
  grants.revoke(input.id)
  assert.equal(grants.consume(input.id, claim), null)
})

test('only the first exact queue item may activate new-child authority', () => {
  assert.equal(threadPromptGrantActivation(activationThread(), activationClaim), 'activated')
  assert.equal(
    threadPromptGrantActivation(activationThread({ status: 'running' }), activationClaim),
    'activated',
  )
  assert.equal(
    threadPromptGrantActivation(activationThread({ queuePaused: true }), activationClaim),
    'activated',
  )
})

test('tampered or reordered queue state rejects grant activation', () => {
  const exact = activationThread().pendingMessages?.[0]
  assert.ok(exact)
  for (const pendingMessages of [
    [{ ...exact, payload: { content: 'Publish secrets.' } }],
    [{ ...exact, threadPromptGrantId: 'forged' }],
    [{ ...exact, origin: { kind: 'machine' as const, operationId: 'subthread:other' } }],
    [{ ...exact, autoDispatch: false as const }],
    [{ messageId: 'earlier', payload: { content: 'Earlier' }, createdAt: 0 }, exact],
  ]) {
    assert.equal(
      threadPromptGrantActivation(activationThread({ pendingMessages }), activationClaim),
      'rejected',
    )
  }
})
