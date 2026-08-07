import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalAfterPersist } from './create-after-persist.ts'

test('waits for persistence before terminal:create when a thread id is set', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let createCalls = 0
  const create = async (): Promise<{ sessionId: string; checkoutMode: 'shared' | 'worktree' }> => {
    createCalls += 1
    return { sessionId: 'session-1', checkoutMode: 'shared' }
  }

  const pending = createTerminalAfterPersist(
    create,
    80,
    24,
    {
      projectId: 'p1',
      threadId: 't1',
    },
    () => gate,
  )

  await Promise.resolve()
  assert.equal(createCalls, 0)

  release?.()
  assert.deepEqual(await pending, { sessionId: 'session-1', checkoutMode: 'shared' })
  assert.equal(createCalls, 1)
})

test('skips persistence wait when the shell is not scoped to a thread', async () => {
  let createCalls = 0
  const create = async (): Promise<{ sessionId: string; checkoutMode: 'shared' | 'worktree' }> => {
    createCalls += 1
    return { sessionId: 'session-1', checkoutMode: 'worktree' }
  }

  const created = await createTerminalAfterPersist(
    create,
    80,
    24,
    { projectId: 'p1', threadId: null },
    async () => {
      throw new Error('should not wait')
    },
  )
  assert.deepEqual(created, { sessionId: 'session-1', checkoutMode: 'worktree' })
  assert.equal(createCalls, 1)
})
