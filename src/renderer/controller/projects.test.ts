import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  attachProjectThreadCache,
  getSidebarThreads,
  isProjectSwitchInFlight,
  resetProjectSwitchStateForTest,
  restoreProject,
  setThreadCacheForTest,
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
}): ApiClient {
  return {
    workspace: {
      set: handlers.workspaceSet ?? (async (path) => path),
    },
    storage: {
      get: handlers.storageGet ?? (async () => null),
      set: handlers.storageSet ?? (async () => undefined),
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
    releaseWorkspace = () => resolve('/b')
  })

  const api = makeApi({
    workspaceSet: () => workspaceGate,
    storageGet: async (key) => {
      if (key === 'threads:b') return [thread('t-b1'), thread('t-b2')]
      return null
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
    releaseWorkspace = () => resolve('/b')
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
    storageGet: async (key) => {
      if (key === 'threads:b') return [thread('t-b1'), thread('t-b2')]
      return null
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
    storageGet: async (key) => {
      if (key === 'threads:b') return [thread('t-b')]
      if (key === 'threads:c') return [thread('t-c')]
      return null
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
    releaseWorkspace = () => resolve('/a')
  })

  const api = makeApi({
    workspaceSet: () => workspaceGate,
    storageGet: async (key) => {
      if (key === 'threads:a') return [thread('t-a')]
      return null
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
