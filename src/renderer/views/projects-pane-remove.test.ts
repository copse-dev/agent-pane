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
import { clickActiveConfirmDialogConfirm, mountConfirmDialog } from './confirm-dialog.ts'

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

  function makeApi(
    orphans: OrphanProjectStore[] = [],
    opts: {
      storage?: Record<string, unknown>
      onStorageSet?: (key: string, value: unknown) => void
      workspaceOpen?: () => Promise<string | null>
    } = {},
  ): ApiClient {
    const storage: Record<string, unknown> = { ...(opts.storage ?? {}) }
    return ((): ApiClient => {
      const base = createFakeApi()
      return {
        ...base,
        workspace: {
          ...base['workspace'],
          set: async (path: string): Promise<string> => path,
          open: opts.workspaceOpen ?? (async (): Promise<string | null> => null),
        },
        storage: {
          ...base['storage'],
          get: async (key: string): Promise<unknown> => storage[key] ?? null,
          set: async (key: string, value: unknown): Promise<void> => {
            storage[key] = value
            opts.onStorageSet?.(key, value)
          },
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
    mount(
      store,
      makeApi([
        {
          id: 'orphan',
          threadCount: 2,
          sampleTitles: ['Planning notes', 'Follow-up'],
          updatedAt: 100,
        },
      ]),
    )
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
    assert.equal(document.querySelector('.orphan-name')?.textContent, 'Planning notes')
    assert.match(document.querySelector('.orphan-meta')?.textContent ?? '', /2 threads/)
    assert.equal(document.querySelector('.orphan-recover-btn')?.textContent, 'Recover…')
    assert.equal(document.querySelector('.orphan-dismiss-btn')?.textContent, 'Dismiss')
  })

  it('dismisses an orphan row and persists the store id', async () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t-a', 'Thread A')],
      activeThreadId: 't-a',
    })
    const writes: Array<{ key: string; value: unknown }> = []
    mount(
      store,
      makeApi(
        [
          {
            id: 'stale-store',
            threadCount: 1,
            sampleTitles: ['Old notes'],
            updatedAt: 50,
          },
        ],
        {
          onStorageSet: (key, value) => {
            writes.push({ key, value })
          },
        },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(document.querySelectorAll('.orphan-row').length, 1)
    document.querySelector<HTMLButtonElement>('.orphan-dismiss-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(document.querySelectorAll('.orphan-row').length, 0)
    assert.deepEqual(writes, [{ key: 'dismissedOrphanStores', value: ['stale-store'] }])
  })

  it('shows orphan thread titles before opening the folder picker on recover', async () => {
    mountConfirmDialog()
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [thread('t-a', 'Thread A')],
      activeThreadId: 't-a',
    })
    let opened = 0
    mount(
      store,
      makeApi(
        [
          {
            id: 'recover-me',
            threadCount: 1,
            sampleTitles: ['Recovered planning notes'],
            updatedAt: 90,
          },
        ],
        {
          workspaceOpen: async () => {
            opened += 1
            return '/recovered'
          },
        },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.orphan-recover-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(opened, 0, 'folder picker waits for confirm')
    assert.match(
      document.querySelector('.confirm-dialog-message')?.textContent ?? '',
      /Recovered planning notes/,
    )
    assert.match(
      document.querySelector('.confirm-dialog-detail')?.textContent ?? '',
      /Recovered planning notes/,
    )
    clickActiveConfirmDialogConfirm()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(opened, 1)
    assert.ok(
      store.getState().projects.some((p) => p.id === 'recover-me' && p.path === '/recovered'),
    )
  })
})
