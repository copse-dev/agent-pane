// The sort menu beside the thread filter re-orders each project's threads and
// remembers the choice. The store's own order stays newest-prompted first.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { mountProjectsPane } from './projects-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function thread(id: string, title: string, createdAt: number): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt,
    updatedAt: createdAt,
  }
}

function mount(initial: { sort?: 'activity' | 'created' | 'title'; reverse?: boolean } = {}): {
  store: ReturnType<typeof createStore>
  saved: Array<[string, unknown]>
} {
  const saved: Array<[string, unknown]> = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
    settings: {
      ...base['settings'],
      set: (key, value): Promise<void> => {
        saved.push([key, value])
        return Promise.resolve()
      },
    },
  }
  // Store order: most recently prompted first, which is neither creation nor title order.
  const store = createStore({
    projects: [{ id: 'p1', path: '/work', name: 'work' }],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads: [thread('b', 'beta', 20), thread('c', 'Charlie', 30), thread('a', 'alpha', 10)],
    activeThreadId: 'b',
    sidebarThreadSort: initial.sort ?? 'activity',
    sidebarThreadSortReverse: initial.reverse ?? false,
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, api)
  return { store, saved }
}

const titles = (): string[] =>
  Array.from(document.querySelectorAll('.chats-list .chat-title')).map((n) => n.textContent)

function choose(label: string): void {
  document.querySelector<HTMLButtonElement>('.projects-sort-btn')?.click()
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item')).find(
    (button) => button.textContent === label,
  )
  assert.ok(item, `the menu offers "${label}"`)
  item.click()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane thread sort (component)', () => {
  it('lists threads in the store order by default', () => {
    mount()
    assert.deepEqual(titles(), ['beta', 'Charlie', 'alpha'])
  })

  it('draws a restored choice on first paint', () => {
    mount({ sort: 'title' })
    assert.deepEqual(titles(), ['alpha', 'beta', 'Charlie'])
  })

  it('re-sorts and persists when a sort is chosen', () => {
    const { store, saved } = mount()
    choose('Thread name')
    assert.deepEqual(titles(), ['alpha', 'beta', 'Charlie'])
    assert.equal(store.getState().sidebarThreadSort, 'title')
    assert.deepEqual(saved, [['sidebarThreadSort', 'title']])
  })

  it('flips the order and persists when Reverse order is chosen', () => {
    const { store, saved } = mount({ sort: 'created' })
    assert.deepEqual(titles(), ['Charlie', 'beta', 'alpha'])
    choose('Reverse order')
    assert.deepEqual(titles(), ['alpha', 'beta', 'Charlie'])
    assert.equal(store.getState().sidebarThreadSortReverse, true)
    assert.deepEqual(saved, [['sidebarThreadSortReverse', true]])
  })

  it('marks the current sort in the menu', () => {
    mount({ sort: 'created', reverse: true })
    document.querySelector<HTMLButtonElement>('.projects-sort-btn')?.click()
    const checked = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item.is-checked'),
    ).map((button) => button.textContent)
    assert.deepEqual(checked.sort(), ['Created', 'Project', 'Reverse order'])
  })
})
