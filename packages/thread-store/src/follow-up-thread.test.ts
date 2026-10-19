import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildFollowUpThread } from './follow-up-thread.ts'
import type { Thread } from './thread-types.ts'

const parent: Thread = {
  id: 'parent-1',
  title: 'Fix the bug',
  status: 'idle',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  model: 'm',
  createdAt: 1,
  updatedAt: 1,
}

describe('follow-up thread', () => {
  it('links to its parent without copying messages', () => {
    const child = buildFollowUpThread(parent)
    assert.notEqual(child.id, parent.id)
    assert.deepEqual(child.followUpOf, { parentThreadId: 'parent-1' })
    assert.deepEqual(child.messages, [])
    assert.equal(child.model, 'm')
    assert.equal(child.sideChat, undefined)
  })

  it('links to the direct parent only when following up a follow-up', () => {
    const child = buildFollowUpThread(buildFollowUpThread(parent))
    assert.notEqual(child.followUpOf?.parentThreadId, 'parent-1')
  })
})
