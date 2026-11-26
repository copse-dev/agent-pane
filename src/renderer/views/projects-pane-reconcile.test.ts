// The sidebar updates rows in place rather than rebuilding the list (#4397).
// A background change to one thread must leave every other row's DOM node,
// and so its hover, focus and any reference a caller holds, alone.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import { setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { mountProjectsPane } from './projects-pane.ts'
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

const api = ((): ApiClient => {
  const base = createFakeApi()
  return {
    ...base,
    threads: {
      ...base['threads'],
      listOrphans: async (): Promise<never[]> => [],
    },
  } satisfies ApiClient
})()

afterEach(() => {
  document.body.replaceChildren()
})

function mount(): ReturnType<typeof createStore> {
  const store = createStore({
    projects: [
      { id: 'p1', path: '/one', name: 'One' },
      { id: 'p2', path: '/two', name: 'Two' },
    ],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/one',
    threads: [thread('a', 'Alpha'), thread('b', 'Beta'), thread('c', 'Gamma')],
    activeThreadId: 'a',
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, api)
  return store
}

function row(title: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
    (candidate) => candidate.querySelector('.chat-title')?.textContent === title,
  )
  assert.ok(found, `no thread row titled ${title}`)
  return found
}

function projectRow(name: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.project-row')).find(
    (candidate) => candidate.querySelector('.project-name')?.textContent === name,
  )
  assert.ok(found, `no project row named ${name}`)
  return found
}

describe('projects pane in-place updates (component)', () => {
  it('replaces only the row whose thread changed status', () => {
    const store = mount()
    const alpha = row('Alpha')
    const beta = row('Beta')
    const gamma = row('Gamma')
    const one = projectRow('One')
    const two = projectRow('Two')

    setThreadStatus(store, 'b', 'running')

    assert.equal(row('Beta').classList.contains('is-running'), true)
    assert.notEqual(row('Beta'), beta, 'the changed row is rebuilt')
    assert.equal(row('Alpha'), alpha)
    assert.equal(row('Gamma'), gamma)
    assert.equal(projectRow('One'), one)
    assert.equal(projectRow('Two'), two)
    assert.equal(beta.isConnected, false)
  })

  it('keeps every row when a render changes nothing', () => {
    const store = mount()
    const before = Array.from(document.querySelectorAll('.projects-list *'))

    store.emit('threads_changed')
    store.emit('attention_changed')

    assert.deepEqual(Array.from(document.querySelectorAll('.projects-list *')), before)
  })

  it('keeps focus on a row while another thread updates', () => {
    const store = mount()
    const menu = row('Alpha').querySelector<HTMLButtonElement>('.chat-menu-btn')
    assert.ok(menu)
    menu.focus()
    assert.equal(document.activeElement, menu)

    setThreadStatus(store, 'c', 'running')

    assert.equal(document.activeElement, menu)
    assert.equal(menu.isConnected, true)
  })

  it('keeps the list scroll position across a background update', () => {
    const store = mount()
    const list = document.querySelector<HTMLElement>('.projects-list')
    assert.ok(list)
    let scrollPosition = 120
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollPosition,
      set: (value: number): void => {
        scrollPosition = value
      },
    })
    // Chromium clamps the scroll offset when the list's children are removed.
    for (const child of Array.from(list.children)) {
      const remove = child.remove.bind(child)
      child.remove = (): void => {
        remove()
        list.scrollTop = 0
      }
    }

    setThreadStatus(store, 'b', 'running')

    assert.equal(list.scrollTop, 120)
  })

  it('returns to the top when the reader searches or changes the project filter', () => {
    const store = mount()
    const list = document.querySelector<HTMLElement>('.projects-list')
    const search = document.querySelector<HTMLInputElement>('.projects-search-input')
    assert.ok(list && search)
    let scrollPosition = 120
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollPosition,
      set: (value: number): void => {
        scrollPosition = value
      },
    })

    search.value = 'gam'
    search.dispatchEvent(new Event('input'))
    assert.equal(list.scrollTop, 0)

    list.scrollTop = 120
    store.setState({ sidebarProjectFilterId: 'p1' })
    assert.equal(list.scrollTop, 0)
  })

  it('a kept row still acts on the current state when clicked', () => {
    const store = mount()
    const gamma = row('Gamma')
    setThreadStatus(store, 'b', 'running')
    assert.equal(row('Gamma'), gamma)

    gamma.click()

    assert.equal(store.getState().activeThreadId, 'c')
  })
})
