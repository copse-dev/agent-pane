import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { openThreadFromAlert } from './alert-navigation.ts'

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'running',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function fixture(): {
  store: ReturnType<typeof createStore>
  opened: string[]
  open: (projectId: string, threadId: string) => void
} {
  const store = createStore({
    projects: [
      { id: 'project-a', path: '/a', name: 'A' },
      { id: 'project-b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'project-b',
    threads: [thread('t-active')],
    activeThreadId: 't-active',
  })
  store.setState({ backgroundThreads: [{ projectId: 'project-a', thread: thread('t-carried') }] })
  const opened: string[] = []
  return { store, opened, open: (projectId, threadId) => opened.push(`${projectId}/${threadId}`) }
}

describe('openThreadFromAlert', () => {
  it("opens the thread in main's stored project when this window knows it", () => {
    const { store, opened, open } = fixture()
    assert.equal(
      openThreadFromAlert(store, { threadId: 't-finished', projectId: 'project-a' }, open),
      true,
    )
    assert.deepEqual(opened, ['project-a/t-finished'])
  })

  it('places a carried background thread in its owning project without a stored project', () => {
    const { store, opened, open } = fixture()
    openThreadFromAlert(store, { threadId: 't-carried', projectId: null }, open)
    assert.deepEqual(opened, ['project-a/t-carried'])
  })

  it('places a thread of the active project in that project', () => {
    const { store, opened, open } = fixture()
    openThreadFromAlert(store, { threadId: 't-active', projectId: null }, open)
    assert.deepEqual(opened, ['project-b/t-active'])
  })

  it('ignores a stored project this window does not list and falls back to its own lists', () => {
    const { store, opened, open } = fixture()
    openThreadFromAlert(store, { threadId: 't-carried', projectId: 'removed-project' }, open)
    assert.deepEqual(opened, ['project-a/t-carried'])
  })

  it('leaves navigation alone for a thread it cannot place', () => {
    const { store, opened, open } = fixture()
    assert.equal(
      openThreadFromAlert(store, { threadId: 't-unknown', projectId: 'removed-project' }, open),
      false,
    )
    assert.deepEqual(opened, [])
  })
})
