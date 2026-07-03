import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  attachProjectThreadCache,
  getSidebarThreads,
  isProjectSwitchInFlight,
  paginateSidebarThreads,
  resetProjectSwitchStateForTest,
  restoreProject,
  setThreadCacheForTest,
  SIDEBAR_THREADS_PAGE_SIZE,
  switchProject,
  switchProjectThread,
} from './projects.ts'

function thread(id: string, title = id): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-msg`,
        role: 'user',
        content: 'hello',
        toolCalls: [],
        createdAt: 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeApi(handlers: {
  workspaceSet?: (path: string) => Promise<string>
  storageGet?: (key: string) => Promise<unknown>
  storageSet?: (key: string, value: unknown) => Promise<void>
  loadProjectThreads?: (projectId: string) => Promise<Thread[]>
}): ApiClient {
  return {
    workspace: {
      set: handlers.workspaceSet ?? (async (path): Promise<string> => path),
    },
    storage: {
      get: handlers.storageGet ?? (async (): Promise<unknown> => null),
      set: handlers.storageSet ?? (async (): Promise<void> => undefined),
    },
    threads: {
      loadProject: handlers.loadProjectThreads ?? (async (): Promise<Thread[]> => []),
      saveOne: async (): Promise<void> => undefined,
      saveProject: async (): Promise<void> => undefined,
    },
  } as unknown as ApiClient
}

async function waitUntil(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('switchProject expands sidebar before workspace activation finishes', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
    activeThreadId: 't-a',
  })
  attachProjectThreadCache(store)

  let releaseWorkspace!: () => void
  const workspaceGate = new Promise<string>((resolve) => {
    releaseWorkspace = (): void => {
      resolve('/b')
    }
  })

  const api = makeApi({
    workspaceSet: () => workspaceGate,
    loadProjectThreads: async (projectId) => {
      if (projectId === 'b') return [thread('t-b1'), thread('t-b2')]
      return []
    },
  })

  switchProject(store, api, 'b')

  assert.equal(store.getState().expandedProjectId, 'b')
  assert.equal(store.getState().activeProjectId, 'a')
  assert.ok(isProjectSwitchInFlight(store, 'b'))
  assert.deepEqual(getSidebarThreads(store, 'b'), [])

  releaseWorkspace()
  await waitUntil(() => store.getState().activeProjectId === 'b')

  assert.equal(store.getState().expandedProjectId, 'b')
  assert.equal(store.getState().workspaceRoot, '/b')
  assert.equal(store.getState().threads.length, 2)
  assert.equal(store.getState().activeThreadId, 't-b1')
})

test('switchProject uses cached threads in sidebar while activation is in flight', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
  })
  attachProjectThreadCache(store)
  setThreadCacheForTest('b', [thread('cached-b')])

  let releaseWorkspace!: () => void
  const workspaceGate = new Promise<string>((resolve) => {
    releaseWorkspace = (): void => {
      resolve('/b')
    }
  })

  const api = makeApi({ workspaceSet: () => workspaceGate })
  switchProject(store, api, 'b')

  assert.deepEqual(
    getSidebarThreads(store, 'b').map((t) => t.id),
    ['cached-b'],
  )

  releaseWorkspace()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
})

test('switchProjectThread selects the clicked thread after activation', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
  })

  const api = makeApi({
    loadProjectThreads: async (projectId) => {
      if (projectId === 'b') return [thread('t-b1'), thread('t-b2')]
      return []
    },
  })

  switchProjectThread(store, api, 'b', 't-b2')
  await waitUntil(() => store.getState().activeProjectId === 'b')

  assert.equal(store.getState().activeThreadId, 't-b2')
})

test('a superseded project switch does not apply stale workspace state', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
      { id: 'c', path: '/c', name: 'C' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
  })

  const workspaceSets: string[] = []
  const api = makeApi({
    workspaceSet: async (path) => {
      workspaceSets.push(path)
      if (path === '/b') {
        await new Promise((r) => setTimeout(r, 20))
      }
      return path
    },
    loadProjectThreads: async (projectId) => {
      if (projectId === 'b') return [thread('t-b')]
      if (projectId === 'c') return [thread('t-c')]
      return []
    },
  })

  switchProject(store, api, 'b')
  switchProject(store, api, 'c')
  await waitUntil(() => store.getState().activeProjectId === 'c')

  assert.equal(store.getState().workspaceRoot, '/c')
  assert.equal(store.getState().activeThreadId, 't-c')
  assert.ok(workspaceSets.includes('/c'))
  assert.equal(workspaceSets.at(-1), '/c')
})

test('restoreProject does not emit projects_changed before threads are loaded', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [{ id: 'a', path: '/a', name: 'A' }],
    activeProjectId: 'a',
    threads: [],
  })
  const events: string[] = []
  store.on('projects_changed', () => events.push('projects_changed'))
  store.on('workspace_changed', () => events.push('workspace_changed'))
  store.on('threads_changed', () => events.push('threads_changed'))

  let releaseWorkspace!: () => void
  const workspaceGate = new Promise<string>((resolve) => {
    releaseWorkspace = (): void => {
      resolve('/a')
    }
  })

  const api = makeApi({
    workspaceSet: () => workspaceGate,
    loadProjectThreads: async (projectId) => {
      if (projectId === 'a') return [thread('t-a')]
      return []
    },
  })

  const pending = restoreProject(store, api, 'a')
  assert.deepEqual(events, [])
  releaseWorkspace()
  await pending

  assert.equal(store.getState().expandedProjectId, 'a')
  assert.equal(store.getState().threads.length, 1)
  assert.deepEqual(events, ['projects_changed', 'workspace_changed', 'threads_changed'])
})

test('panel visibility persists per project across switches', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
    activeThreadId: 't-a',
    filesPaneOpen: true,
    rightPanelMode: 'terminal',
  })

  const api = makeApi({
    loadProjectThreads: async (projectId) => {
      if (projectId === 'b') return [thread('t-b')]
      if (projectId === 'a') return [thread('t-a')]
      return []
    },
  })

  // Project A has its panel open in terminal mode. Switch to B: B is seen for the
  // first time, so its panel starts closed (default), not inheriting A's panel.
  switchProject(store, api, 'b')
  await waitUntil(() => store.getState().activeProjectId === 'b')
  assert.equal(store.getState().filesPaneOpen, false)
  assert.equal(store.getState().rightPanelMode, 'explorer')

  // Open B's panel in changes mode.
  store.setState({ filesPaneOpen: true, rightPanelMode: 'changes' })

  // Switch back to A: A's terminal panel is restored.
  switchProject(store, api, 'a')
  await waitUntil(() => store.getState().activeProjectId === 'a')
  assert.equal(store.getState().filesPaneOpen, true)
  assert.equal(store.getState().rightPanelMode, 'terminal')

  // Switch back to B: B's changes panel is restored.
  switchProject(store, api, 'b')
  await waitUntil(() => store.getState().activeProjectId === 'b')
  assert.equal(store.getState().filesPaneOpen, true)
  assert.equal(store.getState().rightPanelMode, 'changes')
})

test('paginateSidebarThreads shows the first page by default', () => {
  const threads = Array.from({ length: 15 }, (_, i) => thread(`t-${String(i)}`))
  const result = paginateSidebarThreads(threads, SIDEBAR_THREADS_PAGE_SIZE, null)
  assert.equal(result.visibleThreads.length, SIDEBAR_THREADS_PAGE_SIZE)
  assert.equal(result.visibleCount, SIDEBAR_THREADS_PAGE_SIZE)
  assert.equal(result.hasMore, true)
})

test('paginateSidebarThreads expands to the next page when the active thread is hidden', () => {
  const threads = Array.from({ length: 25 }, (_, i) => thread(`t-${String(i)}`))
  const result = paginateSidebarThreads(threads, SIDEBAR_THREADS_PAGE_SIZE, 't-12')
  assert.equal(result.visibleThreads.length, 20)
  assert.equal(result.visibleCount, 20)
  assert.equal(result.hasMore, true)
  assert.equal(result.visibleThreads.at(-1)?.id, 't-19')
})

test('paginateSidebarThreads expands through the final partial page', () => {
  const threads = Array.from({ length: 15 }, (_, i) => thread(`t-${String(i)}`))
  const result = paginateSidebarThreads(threads, SIDEBAR_THREADS_PAGE_SIZE, 't-12')
  assert.equal(result.visibleThreads.length, 15)
  assert.equal(result.visibleCount, 15)
  assert.equal(result.hasMore, false)
})

test('paginateSidebarThreads hides Show more when all threads fit', () => {
  const threads = Array.from({ length: 8 }, (_, i) => thread(`t-${String(i)}`))
  const result = paginateSidebarThreads(threads, SIDEBAR_THREADS_PAGE_SIZE, null)
  assert.equal(result.visibleThreads.length, 8)
  assert.equal(result.hasMore, false)
})
