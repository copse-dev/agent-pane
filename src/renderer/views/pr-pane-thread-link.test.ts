import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { indexThreadLinks } from './pr-pane.ts'

function thread(id: string, title: string, number: number): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    prRefs: [
      {
        owner: 'acme',
        repo: 'widgets',
        number,
        url: `https://github.com/acme/widgets/pull/${String(number)}`,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

test('indexes persisted PR references to their producing threads', () => {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    threads: [thread('thread-1', 'First thread', 7), thread('thread-2', 'Fix widget', 42)],
  })

  const links = indexThreadLinks(store)
  assert.deepEqual([...links.values()], [
    { threadId: 'thread-1', title: 'First thread' },
    { threadId: 'thread-2', title: 'Fix widget' },
  ])
})
