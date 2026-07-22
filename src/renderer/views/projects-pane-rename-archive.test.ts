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
    return {
      workspace: {
        set: async (path: string): Promise<string> => path,
        open: async (): Promise<string | null> => null,
      },
      storage: {
        get: async (): Promise<unknown> => null,
        set: async (): Promise<void> => undefined,
      },
      threads: {
        loadProject: async (): Promise<Thread[]> => [],
        create: async (): Promise<void> => undefined,
        appendMessage: async (): Promise<void> => undefined,
        updateMeta: async (): Promise<void> => undefined,
        delete: async (): Promise<void> => undefined,
        catalog: async (): Promise<never[]> => [],
        listOrphans: async (): Promise<OrphanProjectStore[]> => [],
      },
    } as unknown as ApiClient
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

  it('right-click offers Rename and Archive; Archive soft-hides the row', () => {
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
    assert.deepEqual(labels, ['Rename', 'Archive'])

    const archiveItem = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((i) => i.textContent === 'Archive')
    assert.ok(archiveItem)
    archiveItem.click()

    assert.equal(document.querySelector('.context-menu'), null)
    assert.equal(
      Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent),
      ['Keep me'],
    )
    const archived = store.getState().threads.find((t) => t.id === 't2')
    assert.ok(archived)
    assert.equal(isThreadArchived(archived), true)
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
})
