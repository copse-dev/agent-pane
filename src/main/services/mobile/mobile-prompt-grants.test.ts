import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extendMobilePromptHistory, MobilePromptGrants } from './mobile-prompt-grants.ts'

function seed(grants: MobilePromptGrants, stillAuthorized: () => boolean = () => true): void {
  grants.mint(
    {
      id: 'grant',
      senderId: 7,
      projectId: 'project',
      threadId: 'thread',
      content: 'Reviewed on the phone',
      history: [{ role: 'assistant', content: 'Frozen provider history' }],
      createsThread: false,
      plan: null,
      model: 'claude-sonnet-4-6',
      expiresAt: Date.now() + 10_000,
    },
    stillAuthorized,
  )
}

test('mobile prompt grants bind sender, target and exact content', () => {
  for (const change of [
    { senderId: 8 },
    { projectId: 'other' },
    { threadId: 'other' },
    { content: 'forged renderer prompt' },
  ]) {
    const grants = new MobilePromptGrants()
    seed(grants)
    assert.equal(
      grants.consume('grant', {
        senderId: 7,
        projectId: 'project',
        threadId: 'thread',
        content: 'Reviewed on the phone',
        ...change,
      }),
      null,
    )
  }
})

test('mobile prompt grants are consumed before downstream work and cannot replay', () => {
  const grants = new MobilePromptGrants()
  seed(grants)
  const expected = {
    senderId: 7,
    projectId: 'project',
    threadId: 'thread',
    content: 'Reviewed on the phone',
  }
  const first = grants.consume('grant', expected)
  assert.ok(first)
  assert.equal(grants.consume('grant', expected), null)
  assert.equal(first.model, 'claude-sonnet-4-6')
  assert.deepEqual(first.history, [{ role: 'assistant', content: 'Frozen provider history' }])
})

test('expired and revoked mobile prompt grants authorize nothing', () => {
  const expired = new MobilePromptGrants()
  expired.mint(
    {
      id: 'expired',
      senderId: 1,
      projectId: 'p',
      threadId: 't',
      content: 'old',
      history: [],
      createsThread: false,
      plan: null,
      expiresAt: Date.now() - 1,
    },
    () => true,
  )
  assert.equal(
    expired.consume('expired', {
      senderId: 1,
      projectId: 'p',
      threadId: 't',
      content: 'old',
    }),
    null,
  )
  const revoked = new MobilePromptGrants()
  seed(revoked)
  revoked.revoke('grant')
  assert.equal(
    revoked.consume('grant', {
      senderId: 7,
      projectId: 'project',
      threadId: 'thread',
      content: 'Reviewed on the phone',
    }),
    null,
  )
})

test('closing one renderer revokes only grants issued to that sender', () => {
  const grants = new MobilePromptGrants()
  seed(grants)
  grants.mint(
    {
      id: 'other',
      senderId: 8,
      projectId: 'project',
      threadId: 'thread',
      content: 'Other window',
      history: [],
      createsThread: false,
      plan: null,
      expiresAt: Date.now() + 10_000,
    },
    () => true,
  )
  grants.revokeSender(7)
  assert.equal(
    grants.consume('grant', {
      senderId: 7,
      projectId: 'project',
      threadId: 'thread',
      content: 'Reviewed on the phone',
    }),
    null,
  )
  assert.ok(
    grants.consume('other', {
      senderId: 8,
      projectId: 'project',
      threadId: 'thread',
      content: 'Other window',
    }),
  )
})

test('device revocation terminally invalidates an unconsumed grant', () => {
  const grants = new MobilePromptGrants()
  let authorized = true
  seed(grants, () => authorized)
  authorized = false
  const expected = {
    senderId: 7,
    projectId: 'project',
    threadId: 'thread',
    content: 'Reviewed on the phone',
  }
  assert.equal(grants.consume('grant', expected), null)
  authorized = true
  assert.equal(grants.consume('grant', expected), null)
})

test('mint freezes provider history before renderer delivery', () => {
  const grants = new MobilePromptGrants()
  const history = [{ role: 'assistant' as const, content: 'Trusted history' }]
  grants.mint(
    {
      id: 'frozen',
      senderId: 7,
      projectId: 'project',
      threadId: 'thread',
      content: 'Phone prompt',
      history,
      createsThread: false,
      plan: null,
      expiresAt: Date.now() + 10_000,
    },
    () => true,
  )
  const [message] = history
  assert.ok(message)
  message.content = 'Mutated after admission'

  const grant = grants.consume('frozen', {
    senderId: 7,
    projectId: 'project',
    threadId: 'thread',
    content: 'Phone prompt',
  })
  assert.deepEqual(grant?.history, [{ role: 'assistant', content: 'Trusted history' }])
})

test('queued delivery accepts only main-owned history appended after phone admission', () => {
  const frozen = [{ role: 'user' as const, content: 'Start the task' }]
  const completed = [
    ...frozen,
    {
      role: 'assistant' as const,
      content: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }],
    },
    {
      role: 'tool' as const,
      toolResults: [{ toolCallId: 'call-1', result: 'completed tool output' }],
    },
    { role: 'assistant' as const, content: 'The active turn finished.' },
  ]
  const admitted = extendMobilePromptHistory(frozen, completed)
  assert.deepEqual(admitted, completed)
  assert.notEqual(admitted, completed)
  assert.equal(
    extendMobilePromptHistory(frozen, [{ role: 'user', content: 'Renderer replacement' }]),
    null,
  )
  assert.equal(extendMobilePromptHistory(frozen, []), null)
})

test('a new phone target rejects provider history inserted through a renderer fork', () => {
  const forged = [{ role: 'user' as const, content: 'Attacker-selected fork context' }]
  assert.equal(extendMobilePromptHistory([], forged, true), null)
  assert.deepEqual(extendMobilePromptHistory([], [], true), [])
  assert.equal(extendMobilePromptHistory(forged, forged, true), null)
})

test('a new phone target stays reserved after one-use consumption until dispatch releases it', () => {
  const grants = new MobilePromptGrants()
  grants.mint(
    {
      id: 'new-thread',
      senderId: 7,
      projectId: 'project',
      threadId: 'fresh',
      content: 'Phone prompt',
      history: [],
      createsThread: true,
      plan: null,
      expiresAt: Date.now() + 10_000,
    },
    () => true,
  )
  assert.equal(grants.isTargetReserved('project', 'fresh'), true)
  assert.ok(
    grants.consume('new-thread', {
      senderId: 7,
      projectId: 'project',
      threadId: 'fresh',
      content: 'Phone prompt',
    }),
  )
  assert.equal(grants.isTargetReserved('project', 'fresh'), true)
  grants.revoke('new-thread')
  assert.equal(grants.isTargetReserved('project', 'fresh'), true)
  grants.releaseTarget('new-thread')
  assert.equal(grants.isTargetReserved('project', 'fresh'), false)
})

test('revocation releases an unconsumed new phone target reservation', () => {
  const grants = new MobilePromptGrants()
  grants.mint(
    {
      id: 'new-thread',
      senderId: 7,
      projectId: 'project',
      threadId: 'fresh',
      content: 'Phone prompt',
      history: [],
      createsThread: true,
      plan: null,
      expiresAt: Date.now() + 10_000,
    },
    () => true,
  )
  grants.revoke('new-thread')
  assert.equal(grants.isTargetReserved('project', 'fresh'), false)
})
