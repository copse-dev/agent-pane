import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalAfterPersist } from './create-after-persist.ts'

test('waits for persistence before terminal:create when a thread id is set', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let createCalls = 0
  const create = async (): Promise<string> => {
    createCalls += 1
    return 'session-1'
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
  assert.equal(await pending, 'session-1')
  assert.equal(createCalls, 1)
})

test('skips persistence wait when the shell is not scoped to a thread', async () => {
  let createCalls = 0
  const create = async (): Promise<string> => {
    createCalls += 1
    return 'session-1'
  }

  const id = await createTerminalAfterPersist(
    create,
    80,
    24,
    { projectId: 'p1', threadId: null },
    async () => {
      throw new Error('should not wait')
    },
  )
  assert.equal(id, 'session-1')
  assert.equal(createCalls, 1)
})
