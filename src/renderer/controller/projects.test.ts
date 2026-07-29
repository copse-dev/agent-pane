import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { SshConnectionState } from '@shared/types/ssh-workspace.ts'
import {
  attachProjectThreadCache,
  getSidebarThreads,
  isProjectSwitchInFlight,
  paginateSidebarThreads,
  removeProject,
  relocateProject,
  resetProjectSwitchStateForTest,
  restoreProject,
  setThreadCacheForTest,
  SIDEBAR_THREADS_PAGE_SIZE,
  switchProject,
  switchProjectThread,
} from './projects.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

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
  workspaceOpen?: () => Promise<string | null>
  workspaceSet?: (path: string, sshHost?: string) => Promise<string>
  storageGet?: (key: string) => Promise<unknown>
  storageSet?: (key: string, value: unknown) => Promise<void>
  loadProjectThreads?: (projectId: string) => Promise<Thread[]>
  settingsGet?: (key: string) => Promise<unknown>
  sshStates?: () => Promise<SshConnectionState[]>
  sshConnect?: (hostId: string) => Promise<void>
}): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      workspace: {
        ...base['workspace'],
        open: handlers.workspaceOpen ?? (async (): Promise<string | null> => null),
        set: handlers.workspaceSet ?? (async (path): Promise<string> => path),
      },
      storage: {
        ...base['storage'],
        get: handlers.storageGet ?? (async (): Promise<unknown> => null),
        set: handlers.storageSet ?? (async (): Promise<void> => undefined),
      },
      threads: {
        ...base['threads'],
        loadProject: handlers.loadProjectThreads ?? (async (): Promise<Thread[]> => []),
        create: async (): Promise<void> => undefined,
        appendMessage: async (): Promise<void> => undefined,
        updateMeta: async (): Promise<void> => undefined,
        delete: async (): Promise<void> => undefined,
        catalog: async (): Promise<never[]> => [],
        listOrphans: async (): Promise<never[]> => [],
      },
      settings: {
        ...base['settings'],
        get: handlers.settingsGet ?? (async (): Promise<unknown> => null),
      },
      sshWorkspace: {
        ...base['sshWorkspace'],
        getStates: handlers.sshStates ?? (async (): Promise<SshConnectionState[]> => []),
        connect: async (hostId: string): Promise<SshConnectionState[]> => {
          await handlers.sshConnect?.(hostId)
          return handlers.sshStates?.() ?? []
        },
      },
    } satisfies ApiClient
  })()
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

test('switchProject passes sshHost through to workspace.set', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'local', path: '/local', name: 'Local' },
      {
        id: 'remote',
        path: '/etc/ddg',
        name: 'ddg',
        sshHost: 'euw-serp-dev-testing16',
      },
    ],
    activeProjectId: 'local',
    expandedProjectId: 'local',
    workspaceRoot: '/local',
    threads: [thread('t-local')],
  })

  const sets: { path: string; sshHost?: string }[] = []
  const api = makeApi({
    workspaceSet: async (path, sshHost) => {
      if (sshHost !== undefined) sets.push({ path, sshHost })
      else sets.push({ path })
      return path
    },
    loadProjectThreads: async () => [thread('t-remote')],
  })
  // SSH connect must succeed for activation to reach workspace.set.
  Object.assign(api, {
    settings: {
      get: async (key: string): Promise<unknown> => (key === 'sshWorkspaceEnabled' ? true : null),
    },
    sshWorkspace: {
      getStates: async () => [
        {
          hostId: 'euw-serp-dev-testing16',
          status: 'connected',
          label: 'dev',
          target: 'dev',
        },
      ],
      connect: async (): Promise<void> => undefined,
    },
  })

  switchProject(store, api, 'remote')
  await waitUntil(() => store.getState().activeProjectId === 'remote')
  assert.deepEqual(sets.at(-1), { path: '/etc/ddg', sshHost: 'euw-serp-dev-testing16' })
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

test('removeProject drops an inactive project without changing the workspace', async () => {
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
  setThreadCacheForTest('b', [thread('cached-b')])

  const saved: Array<{ key: string; value: unknown }> = []
  const api = makeApi({
    storageSet: async (key, value) => {
      saved.push({ key, value })
    },
  })

  await removeProject(store, api, 'b')

  assert.deepEqual(
    store.getState().projects.map((p) => p.id),
    ['a'],
  )
  assert.equal(store.getState().activeProjectId, 'a')
  assert.equal(store.getState().workspaceRoot, '/a')
  assert.equal(store.getState().activeThreadId, 't-a')
  assert.deepEqual(getSidebarThreads(store, 'b'), [])
  assert.ok(saved.some((e) => e.key === 'projects'))
  assert.ok(saved.some((e) => e.key === 'activeProjectId' && e.value === 'a'))
})

test('removeProject switches to another project with its connection when the active one is removed', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B', sshHost: 'remote-b' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
    activeThreadId: 't-a',
  })

  const workspaceCalls: Array<{ path: string; sshHost: string | undefined }> = []
  const api = makeApi({
    workspaceSet: async (path, sshHost) => {
      workspaceCalls.push({ path, sshHost })
      return path
    },
    loadProjectThreads: async (projectId) => {
      if (projectId === 'b') return [thread('t-b')]
      return []
    },
  })
  Object.assign(api, {
    settings: {
      get: async (key: string): Promise<unknown> => (key === 'sshWorkspaceEnabled' ? true : null),
    },
    sshWorkspace: {
      getStates: async () => [
        { hostId: 'remote-b', status: 'connected', label: 'B', target: 'remote-b' },
      ],
      connect: async (): Promise<void> => undefined,
    },
  })

  await removeProject(store, api, 'a')
  await waitUntil(() => store.getState().activeProjectId === 'b')

  assert.deepEqual(
    store.getState().projects.map((p) => p.id),
    ['b'],
  )
  assert.equal(store.getState().workspaceRoot, '/b')
  assert.equal(store.getState().activeThreadId, 't-b')
  assert.deepEqual(workspaceCalls, [{ path: '/b', sshHost: 'remote-b' }])
})

test('removeProject clears the workspace when the last project is removed', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [{ id: 'a', path: '/a', name: 'A' }],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
    activeThreadId: 't-a',
    filesPaneOpen: true,
  })

  const api = makeApi({})
  await removeProject(store, api, 'a')

  assert.deepEqual(store.getState().projects, [])
  assert.equal(store.getState().activeProjectId, null)
  assert.equal(store.getState().expandedProjectId, null)
  assert.equal(store.getState().workspaceRoot, null)
  assert.deepEqual(store.getState().threads, [])
  assert.equal(store.getState().activeThreadId, null)
  assert.equal(store.getState().filesPaneOpen, false)
})

test('restoreProject quarantines a missing project instead of deleting it (#997)', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/b', name: 'B' },
    ],
    activeProjectId: 'a',
    threads: [],
  })

  const persisted: Array<{ key: string; value: unknown }> = []
  const api = makeApi({
    workspaceSet: async (path) => {
      if (path === '/a') throw new Error('folder moved')
      return path
    },
    storageSet: async (key, value) => {
      persisted.push({ key, value })
    },
    loadProjectThreads: async (projectId) => (projectId === 'b' ? [thread('t-b')] : []),
  })

  await restoreProject(store, api, 'a')

  const projects = store.getState().projects
  assert.equal(projects.length, 2)
  assert.equal(projects.find((p) => p.id === 'a')?.missing, true)
  assert.equal(store.getState().activeProjectId, 'b')
  assert.equal(store.getState().workspaceRoot, '/b')
  const lastProjects: unknown = [...persisted].reverse().find((p) => p.key === 'projects')?.value
  assert.ok(Array.isArray(lastProjects))
  assert.equal(lastProjects.length, 2)
})

test('restoreProject keeps an SSH project active when connect fails (disconnect banner)', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'remote', path: '/work', name: 'Remote', sshHost: 'host-a' },
      { id: 'local', path: '/local', name: 'Local' },
    ],
    activeProjectId: 'remote',
    threads: [],
  })
  const api = makeApi({
    settingsGet: async () => true,
    sshStates: async () => [
      { hostId: 'host-a', status: 'disconnected', label: 'Host A', target: 'host-a' },
    ],
    sshConnect: async () => {
      throw new Error('host unavailable')
    },
    loadProjectThreads: async (projectId) => (projectId === 'local' ? [thread('t-local')] : []),
  })

  await restoreProject(store, api, 'remote')

  // Do not quarantine on SSH connect failure — the titlebar disconnect banner
  // needs the project (and its sshHost) to stay active.
  assert.equal(store.getState().projects.find((p) => p.id === 'remote')?.missing, undefined)
  assert.equal(store.getState().activeProjectId, 'remote')
  assert.equal(store.getState().workspaceRoot, null)
})

test('restoreProject quarantines an SSH project when the remote folder cannot open', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'remote', path: '/gone', name: 'Remote', sshHost: 'host-a' },
      { id: 'local', path: '/local', name: 'Local' },
    ],
    activeProjectId: 'remote',
    threads: [],
  })
  const api = makeApi({
    settingsGet: async () => true,
    sshStates: async () => [
      { hostId: 'host-a', status: 'connected', label: 'Host A', target: 'host-a' },
    ],
    workspaceSet: async (path) => {
      if (path === '/gone') throw new Error('remote path missing')
      return path
    },
    loadProjectThreads: async (projectId) => (projectId === 'local' ? [thread('t-local')] : []),
  })

  await restoreProject(store, api, 'remote')

  assert.equal(store.getState().projects.find((p) => p.id === 'remote')?.missing, true)
  assert.equal(store.getState().activeProjectId, 'local')
  assert.equal(store.getState().workspaceRoot, '/local')
  assert.equal(store.getState().activeThreadId, 't-local')
})

test('switchProject quarantines on activation failure and stays put (#997)', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [
      { id: 'a', path: '/a', name: 'A' },
      { id: 'b', path: '/gone', name: 'B' },
    ],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads: [thread('t-a')],
    activeThreadId: 't-a',
  })

  const api = makeApi({
    workspaceSet: async (path) => {
      if (path === '/gone') throw new Error('folder moved')
      return path
    },
  })

  switchProject(store, api, 'b')
  await waitUntil(() => store.getState().projects.find((p) => p.id === 'b')?.missing === true)

  assert.equal(store.getState().activeProjectId, 'a')
  assert.equal(store.getState().workspaceRoot, '/a')
  assert.equal(store.getState().projects.length, 2)
  assert.equal(store.getState().threads.length, 1)
})

test('relocateProject re-points a missing project and clears the flag (#997)', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [{ id: 'a', path: '/old', name: 'A', missing: true }],
    activeProjectId: null,
    threads: [],
  })

  const api = makeApi({
    workspaceOpen: async () => '/new',
    workspaceSet: async (path) => path,
    loadProjectThreads: async () => [thread('t-a')],
  })

  const ok = await relocateProject(store, api, 'a')
  assert.equal(ok, true)

  const project = store.getState().projects.find((p) => p.id === 'a')
  assert.ok(project)
  assert.equal(project.path, '/new')
  assert.equal(project.missing, undefined)
  assert.equal(store.getState().activeProjectId, 'a')
  assert.equal(store.getState().workspaceRoot, '/new')
  assert.equal(store.getState().threads.length, 1)
})

test('relocateProject is a no-op when the folder picker is cancelled', async () => {
  resetProjectSwitchStateForTest()
  const store = createStore({
    projects: [{ id: 'a', path: '/old', name: 'A', missing: true }],
    activeProjectId: null,
    threads: [],
  })
  const api = makeApi({ workspaceOpen: async () => null })

  const ok = await relocateProject(store, api, 'a')
  assert.equal(ok, false)
  const project = store.getState().projects.find((p) => p.id === 'a')
  assert.ok(project)
  assert.equal(project.path, '/old')
  assert.equal(project.missing, true)
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
