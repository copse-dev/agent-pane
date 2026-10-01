// Double-click / context-menu rename + archive for sidebar thread rows.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { OrphanProjectStore, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { isThreadArchived } from '@shared/store/thread-helpers.ts'
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

afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('projects pane thread rename + archive (component)', () => {
  function mount(store: ReturnType<typeof createStore>, api: ApiClient): HTMLElement {
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)
    return host
  }

  function makeApi(): ApiClient {
    return ((): ApiClient => {
      const base = createFakeApi()
      return {
        ...base,
        workspace: {
          ...base['workspace'],
          set: async (path: string): Promise<string> => path,
          open: async (): Promise<string | null> => null,
        },
        storage: {
          ...base['storage'],
          get: async (): Promise<unknown> => null,
          set: async (): Promise<void> => undefined,
        },
        threads: {
          ...base['threads'],
          loadProject: async (): Promise<Thread[]> => [],
          create: async (): Promise<void> => undefined,
          appendMessage: async (): Promise<void> => undefined,
          updateMeta: async (): Promise<void> => undefined,
          delete: async (): Promise<void> => undefined,
          catalog: async (): Promise<never[]> => [],
          listOrphans: async (): Promise<OrphanProjectStore[]> => [],
        },
      } satisfies ApiClient
    })()
  }

  function rowFor(title: string): HTMLElement {
    const row = Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
      (r) => r.querySelector('.chat-title')?.textContent === title,
    )
    assert.ok(row, `expected chat row titled ${title}`)
    return row
  }

  it('double-clicking a thread title enters rename and saves on Enter', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t1', 'Alpha chat'), thread('t2', 'Beta chat')],
      activeThreadId: 't1',
    })
    mount(store, makeApi())

    const title = rowFor('Alpha chat').querySelector('.chat-title')
    assert.ok(title)
    title.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))

    const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
    assert.ok(input, 'rename input mounts')
    input.value = 'Renamed chat'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )

    assert.equal(document.querySelector('.chat-title-rename'), null)
    assert.equal(store.getState().threads.find((t) => t.id === 't1')?.title, 'Renamed chat')
    assert.ok(rowFor('Renamed chat'))
  })

  it('right-click offers Rename, Fork, Archive and Delete; Archive soft-hides the row', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t1', 'Keep me'), thread('t2', 'Archive me')],
      activeThreadId: 't1',
    })
    mount(store, makeApi())

    rowFor('Archive me').dispatchEvent(
      new window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 80,
      }),
    )

    const menu = document.querySelector<HTMLElement>('.context-menu')
    assert.ok(menu)
    const labels = Array.from(menu.querySelectorAll('.context-menu-item')).map((i) => i.textContent)
    assert.deepEqual(labels, ['Rename', 'Fork', 'Archive', 'Delete'])

    const archiveItem = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((i) => i.textContent === 'Archive')
    assert.ok(archiveItem)
    archiveItem.click()

    assert.equal(document.querySelector('.context-menu'), null)
    assert.deepEqual(
      Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent),
      ['Keep me'],
    )
    const archived = store.getState().threads.find((t) => t.id === 't2')
    assert.ok(archived)
    assert.equal(isThreadArchived(archived), true)
  })

  it('the vertical-dot button opens the same menu without switching threads; Delete removes its thread', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t1', 'Keep me'), thread('t2', 'Delete me')],
      activeThreadId: 't1',
    })
    const cleared: string[][] = []
    const api = makeApi()
    api.agent.clearHistory = async (projectId, threadId): Promise<void> => {
      cleared.push([projectId, threadId])
    }
    mount(store, api)
    const row = rowFor('Delete me')
    const button = row.querySelector<HTMLButtonElement>('.chat-menu-btn')
    assert.ok(button)
    assert.equal(button.getAttribute('aria-label'), 'Thread menu for Delete me')
    assert.equal(button.getAttribute('aria-haspopup'), 'menu')
    assert.ok(button.querySelector('[data-icon="more-vertical"]'))
    button.click()

    const labels = (): (string | null)[] =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((item) => item.textContent)
    const buttonLabels = labels()
    assert.deepEqual(buttonLabels, ['Rename', 'Fork', 'Archive', 'Delete'])
    assert.equal(store.getState().activeThreadId, 't1')
    assert.equal(store.getState().threads.length, 2)
    assert.deepEqual(cleared, [])
    dismissContextMenu()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    assert.deepEqual(labels(), buttonLabels)
    dismissContextMenu()
    button.click()

    const deleteItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((item) => item.textContent === 'Delete')
    assert.ok(deleteItem)
    assert.equal(deleteItem.disabled, false)
    deleteItem.click()
    assert.equal(document.querySelector('.context-menu'), null)
    assert.deepEqual(
      store.getState().threads.map((item) => item.id),
      ['t1'],
    )
    assert.equal(store.getState().activeThreadId, 't1')
    assert.deepEqual(cleared, [['a', 't2']])

    rowFor('Keep me').querySelector<HTMLButtonElement>('.chat-menu-btn')?.click()
    const lastDeleteItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((item) => item.textContent === 'Delete')
    assert.ok(lastDeleteItem)
    assert.equal(lastDeleteItem.disabled, true)
    lastDeleteItem.click()
    assert.equal(store.getState().threads.length, 1)
    assert.deepEqual(cleared, [['a', 't2']])
  })

  it('context-menu Rename starts inline editing', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t1', 'Editable')],
      activeThreadId: 't1',
    })
    mount(store, makeApi())

    rowFor('Editable').dispatchEvent(
      new window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 40,
      }),
    )
    const renameItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((i) => i.textContent === 'Rename')
    assert.ok(renameItem)
    renameItem.click()

    const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
    assert.ok(input)
    assert.equal(input.value, 'Editable')
  })

  it('keeps the rename input mounted when blur races focus() after open', async () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t1', 'Race me')],
      activeThreadId: 't1',
    })
    mount(store, makeApi())

    const title = rowFor('Race me').querySelector('.chat-title')
    assert.ok(title)
    title.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))

    const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
    assert.ok(input)

    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    input.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0)
    })

    assert.ok(
      document.querySelector('.chat-title-rename'),
      'rename input must survive an immediate blur after open',
    )
    assert.equal(store.getState().threads.find((t) => t.id === 't1')?.title, 'Race me')
  })
})
