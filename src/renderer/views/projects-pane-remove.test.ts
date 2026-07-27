// Right-clicking a project row opens a context menu that removes the project
// from the sidebar config — not from disk.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { OrphanProjectStore, Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
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
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('projects pane remove-from-sidebar (component)', () => {
  function mount(store: ReturnType<typeof createStore>, api: ApiClient): HTMLElement {
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)
    return host
  }

  function makeApi(orphans: OrphanProjectStore[] = []): ApiClient {
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
          listOrphans: async (): Promise<OrphanProjectStore[]> => orphans,
        },
      } satisfies ApiClient
    })()
  }

  it('opens a Remove from sidebar menu on project-row contextmenu', () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'b', path: '/b', name: 'Beta' },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t-a', 'Thread A')],
      activeThreadId: 't-a',
    })
    mount(store, makeApi())

    const beta = Array.from(document.querySelectorAll<HTMLButtonElement>('.project-row')).find(
      (row) => row.querySelector('.project-name')?.textContent === 'Beta',
    )
    assert.ok(beta)

    beta.dispatchEvent(
      new window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 80,
      }),
    )

    const menu = document.querySelector<HTMLElement>('.context-menu')
    assert.ok(menu, 'context menu is mounted')
    assert.equal(menu.getAttribute('role'), 'menu')
    const item = menu.querySelector<HTMLButtonElement>('.context-menu-item')
    assert.ok(item)
    assert.equal(item.textContent, 'Remove from sidebar')
  })

  it('removes the project from the sidebar when the menu item is clicked', async () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'b', path: '/b', name: 'Beta' },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t-a', 'Thread A')],
      activeThreadId: 't-a',
    })
    mount(store, makeApi())

    const beta = Array.from(document.querySelectorAll<HTMLButtonElement>('.project-row')).find(
      (row) => row.querySelector('.project-name')?.textContent === 'Beta',
    )
    assert.ok(beta)
    beta.dispatchEvent(
      new window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 80,
      }),
    )

    const item = document.querySelector<HTMLButtonElement>('.context-menu-item')
    assert.ok(item)
    item.click()

    await new Promise((r) => setTimeout(r, 0))

    assert.deepEqual(
      store.getState().projects.map((p) => p.name),
      ['Alpha'],
    )
    assert.equal(document.querySelector('.context-menu'), null, 'menu dismisses after click')
    const names = Array.from(document.querySelectorAll('.project-name')).map((n) => n.textContent)
    assert.deepEqual(names, ['Alpha'])
  })

  it('renders a quarantined project notice and recoverable orphan stores', async () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'Alpha' },
        { id: 'missing', path: '/gone', name: 'Moved project', missing: true },
      ],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t-a', 'Thread A')],
      activeThreadId: 't-a',
    })
    mount(store, makeApi([{ id: 'orphan', threadCount: 2 }]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const missingRow = document.querySelector<HTMLButtonElement>('.project-row.missing')
    assert.ok(missingRow)
    assert.match(missingRow.title, /folder missing/i)
    assert.ok(missingRow.querySelector('.project-missing-icon'))
    missingRow.click()

    assert.match(
      document.querySelector('.project-missing-text')?.textContent ?? '',
      /threads are safe.*relocate/i,
    )
    assert.equal(document.querySelector('.project-missing-btn')?.textContent, 'Relocate…')
    assert.equal(document.querySelector('.orphans-heading')?.textContent, 'Recoverable threads')
    assert.equal(document.querySelector('.orphan-name')?.textContent, '2 threads')
    assert.equal(document.querySelector('.orphan-recover-btn')?.textContent, 'Recover…')
  })
})
