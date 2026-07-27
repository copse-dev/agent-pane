// The sidebar's thread window grows to reveal the active thread, but must never
// shrink-and-stick: a project showing a single thread once pinned its window at
// one row, so the next thread it gained (a new chat, a fork) landed behind
// "Show more" instead of appearing in the sidebar.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { mountProjectsPane } from './projects-pane.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { SIDEBAR_THREADS_PAGE_SIZE } from '../controller/projects.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function chatTitles(): Array<string | null> {
  return Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent)
}

afterEach(() => {
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('projects pane thread window (component)', () => {
  function mountWith(threads: Thread[]): ReturnType<typeof createStore> {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads,
      activeThreadId: threads[0]?.id ?? null,
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, createFakeApi())
    return store
  }

  it('shows a newly added thread instead of hiding it behind Show more', () => {
    const store = mountWith([thread('t1', 'Only chat')])
    assert.deepEqual(chatTitles(), ['Only chat'])
    assert.equal(document.querySelector('.chats-show-more'), null)

    // A fork (or any new chat) prepends a thread and makes it active.
    store.setState({
      threads: [thread('t2', 'Only chat (fork)'), thread('t1', 'Only chat')],
      activeThreadId: 't2',
    })
    store.emit('threads_changed')

    assert.deepEqual(chatTitles(), ['Only chat (fork)', 'Only chat'])
    assert.equal(document.querySelector('.chats-show-more'), null)
  })

  it('still pages a project with more threads than one window', () => {
    const many = Array.from({ length: SIDEBAR_THREADS_PAGE_SIZE + 3 }, (_, i) =>
      thread(`t${String(i)}`, `Chat ${String(i)}`),
    )
    mountWith(many)

    assert.equal(chatTitles().length, SIDEBAR_THREADS_PAGE_SIZE)
    assert.ok(document.querySelector('.chats-show-more'))
  })
})
